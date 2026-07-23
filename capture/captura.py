"""Captura do mapa de salas: planilha da universidade -> Supabase.

Porta o parser do v1 (visualizar_planilha.py: parsear_e_organizar) sem pandas.
Sem SUPABASE_URL/SUPABASE_SERVICE_KEY no ambiente, roda em dry-run e só
imprime o resumo do parse (útil pra testar o parser isolado).
"""

import csv
import io
import json
import os
import sys
import unicodedata
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

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


def enviar(linhas):
    base = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1"
    key = os.environ["SUPABASE_SERVICE_KEY"]

    # mapa do dia: mesma semântica do keep="last" do v1 (atualiza a sala)
    _post(f"{base}/mapa_dia", key, linhas, "data,merge_key", "merge-duplicates")

    # side-effects do v1: catálogo de disciplinas e inventário de salas
    disc = {l["codigo"]: {
        "codigo": l["codigo"], "turma": l["turma"],
        "disciplina": l["disciplina"], "professor": l["professor"],
    } for l in linhas if l["codigo"]}
    if disc:
        _post(f"{base}/disciplinas_historico", key, list(disc.values()),
              "codigo", "merge-duplicates")

    salas = {l["sala"]: {
        "sala": l["sala"],
        "predio": "P2" if "(P2)" in l["sala"] else "P1",
    } for l in linhas if l["sala"]}
    if salas:
        _post(f"{base}/salas", key, list(salas.values()), "sala", "ignore-duplicates")


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

    if os.environ.get("SUPABASE_URL") and os.environ.get("SUPABASE_SERVICE_KEY"):
        enviar(linhas)
        print("upsert ok")
    else:
        print("dry-run (sem SUPABASE_URL/SUPABASE_SERVICE_KEY)")
        for l in linhas[:5]:
            print("  ", {k: v for k, v in l.items() if k != "data"})


if __name__ == "__main__":
    main()
