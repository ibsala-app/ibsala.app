"""Captura do mapa de salas: planilha da universidade -> Supabase.

Porta o parser do v1 (visualizar_planilha.py: parsear_e_organizar) sem pandas.
Sem SUPABASE_URL/SUPABASE_SERVICE_KEY no ambiente, roda em dry-run e só
imprime o resumo do parse (útil pra testar o parser isolado).
"""

import csv
import io
import json
import os
import re
import sys
import unicodedata
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

REPERTORIO_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               os.pardir, "salas-repertorio.json")

SPREADSHEET_ID = "1-TyWurlvjDaiGwRmNFlq3OyK8ia4UP3fPpiSxyL2d3Y"
EXPORT_URL = f"https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/export?format=csv"

TITULOS_CATEGORIA = [
    "GRADUAÇÃO - MANHÃ",
    "GRADUAÇÃO - TARDE",
    "GRADUAÇÃO - NOITE",
    "OUTRAS RESERVAS - NOITE",
]

BRT = ZoneInfo("America/Sao_Paulo")


def _sem_acento(texto):
    nfd = unicodedata.normalize("NFD", str(texto))
    return "".join(c for c in nfd if unicodedata.category(c) != "Mn").strip()


def _extrair_codigo(texto):
    """'IBM0022-8001/ JURISDICAO E PROCESSO' -> ('IBM0022-8001', 'JURISDICAO E PROCESSO')."""
    if "/" in str(texto):
        codigo, nome = str(texto).split("/", 1)
        return codigo.strip(), nome.strip()
    return "", str(texto).strip()


def _chave(texto):
    """Chave de casamento do repertório: sem acento, espaço interno colapsado,
    maiúscula. A planilha escreve a mesma sala como '107 (P2) LAB. METROLOGIA'
    e '107 (P2) - LAB.METROLOGIA', então comparar string crua não serve."""
    return re.sub(r"\s+", " ", _sem_acento(texto)).strip().upper()


def carregar_repertorio(caminho=REPERTORIO_PATH):
    """Lê salas-repertorio.json (fonte única, idêntica no repo do v1)."""
    with open(caminho, encoding="utf-8") as f:
        rep = json.load(f)
    return {
        "salas": {_chave(s): s for s in rep["salas"]},
        "predio": dict(rep["salas"]),
        "apelidos": {_chave(a): c for a, c in rep["apelidos"].items()},
        "ignoradas": {_chave(i) for i in rep["ignoradas"]},
    }


def resolver_sala(bruta, rep):
    """Grafia crua da planilha -> (canônica, motivo).

    canônica é None quando a linha não ocupa sala nenhuma. Motivos: 'canonica',
    'apelido', 'ignorada', 'vazia', 'desconhecida'.
    """
    k = _chave(bruta)
    if not k:
        return None, "vazia"
    if "/" in k:
        # par concatenado ("302/303") é erro do sistema de origem: essa sala não
        # existe e a linha não ocupa nada
        return None, "ignorada"
    if k in rep["ignoradas"]:
        return None, "ignorada"
    if k in rep["salas"]:
        return rep["salas"][k], "canonica"
    if k in rep["apelidos"]:
        return rep["apelidos"][k], "apelido"
    return None, "desconhecida"


def anotar_canonicas(linhas, rep):
    """Preenche sala_canon em cada linha. Devolve as grafias desconhecidas
    (grafia crua -> nº de ocorrências) pra quarentena."""
    pendentes = {}
    for l in linhas:
        canon, motivo = resolver_sala(l.get("sala", ""), rep)
        l["sala_canon"] = canon
        if motivo == "desconhecida":
            bruta = str(l.get("sala", "")).strip()
            pendentes[bruta] = pendentes.get(bruta, 0) + 1
    return pendentes


def baixar_csv():
    req = urllib.request.Request(EXPORT_URL, headers={"User-Agent": "ibsala-captura/2.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read().decode("utf-8-sig")


def parsear(texto_csv):
    """Replica parsear_e_organizar do v1: seções por título de categoria,
    linha-header começando em 'Turma', valores até a próxima seção."""
    registros = []
    categoria = None
    colunas = None

    for valores in csv.reader(io.StringIO(texto_csv)):
        col0 = valores[0].strip() if valores else ""
        resto_vazio = all(not v.strip() for v in valores[1:])

        if col0 in TITULOS_CATEGORIA and resto_vazio:
            categoria = col0
            colunas = None
            continue

        if col0 == "Turma" and categoria:
            colunas = [_sem_acento(v) if v.strip() else f"col{i}" for i, v in enumerate(valores)]
            continue

        if categoria and colunas and col0 and col0 != "nan":
            valores += [""] * (len(colunas) - len(valores))
            reg = {"Categoria": categoria}
            for i, col in enumerate(colunas):
                reg[col] = valores[i].strip()
            if any(v for k, v in reg.items() if k != "Categoria"):
                registros.append(reg)

    # coluna de horário costuma vir sem header ("colN"); primeira vazia vira Horario
    for reg in registros:
        if "Horario" not in reg:
            for k in list(reg):
                if k.startswith("col"):
                    reg["Horario"] = reg.pop(k)
                    break

    linhas = []
    hoje = datetime.now(BRT).date().isoformat()
    for reg in registros:
        # linha sem disciplina e sem horário não é aula (títulos perdidos,
        # subtotais); a fonte tem seções de sábado com typo fora de
        # TITULOS_CATEGORIA que vazam pra cá
        if not reg.get("Disciplina", "").strip() and not reg.get("Horario", "").strip():
            continue
        codigo, disciplina = _extrair_codigo(reg.get("Disciplina", ""))
        linhas.append({
            "data": hoje,
            "categoria": reg["Categoria"],
            "turma": reg.get("Turma", ""),
            "codigo": codigo,
            "disciplina": disciplina,
            "horario": reg.get("Horario", ""),
            "professor": reg.get("Professor", ""),
            "sala": reg.get("Salas", reg.get("Sala", "")),
        })
    return linhas


def _post(url, key, payload, on_conflict, resolution):
    req = urllib.request.Request(
        f"{url}?on_conflict={on_conflict}",
        data=json.dumps(payload).encode(),
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": f"resolution={resolution}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.status


def enviar(linhas, rep, pendentes=None):
    base = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1"
    key = os.environ["SUPABASE_SERVICE_KEY"]

    # mapa do dia: mesma semântica do keep="last" do v1 (atualiza a sala)
    _post(f"{base}/mapa_dia", key, linhas, "data,merge_key", "merge-duplicates")

    # side-effect do v1: catálogo de disciplinas
    disc = {l["codigo"]: {
        "codigo": l["codigo"], "turma": l["turma"],
        "disciplina": l["disciplina"], "professor": l["professor"],
    } for l in linhas if l["codigo"]}
    if disc:
        _post(f"{base}/disciplinas_historico", key, list(disc.values()),
              "codigo", "merge-duplicates")

    # o repertório manda: sala nova nasce no JSON, não no que a planilha cospe.
    # upsert idempotente pra dispensar migration quando uma sala é acrescentada
    _post(f"{base}/salas", key,
          [{"sala": s, "predio": p} for s, p in rep["predio"].items()],
          "sala", "ignore-duplicates")

    # grafia fora do repertório fica em quarentena: não vira sala livre e espera
    # revisão humana
    if pendentes:
        _post(f"{base}/salas_pendentes", key,
              [{"alias": a, "ocorrencias": n} for a, n in pendentes.items()],
              "alias", "merge-duplicates")


def main():
    linhas = parsear(baixar_csv())
    if not linhas:
        # estado legítimo em férias/fim de semana; a planilha da fonte fica vazia
        print("0 linhas capturadas (planilha vazia)")
        return

    por_cat = {}
    for l in linhas:
        por_cat[l["categoria"]] = por_cat.get(l["categoria"], 0) + 1
    print(f"{len(linhas)} linhas: " + ", ".join(f"{c}={n}" for c, n in por_cat.items()))

    rep = carregar_repertorio()
    pendentes = anotar_canonicas(linhas, rep)
    ocupando = sum(1 for l in linhas if l["sala_canon"])
    print(f"{ocupando} linhas ocupam sala do repertório; "
          f"{len(linhas) - ocupando} sem sala (vazia, ignorada ou desconhecida)")
    if pendentes:
        print("quarentena: " + ", ".join(f"{a!r}x{n}" for a, n in pendentes.items()))

    if os.environ.get("SUPABASE_URL") and os.environ.get("SUPABASE_SERVICE_KEY"):
        enviar(linhas, rep, pendentes)
        print("upsert ok")
    else:
        print("dry-run (sem SUPABASE_URL/SUPABASE_SERVICE_KEY)")
        for l in linhas[:5]:
            print("  ", {k: v for k, v in l.items() if k != "data"})


if __name__ == "__main__":
    main()
