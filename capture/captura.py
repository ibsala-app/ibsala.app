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
    """Chave de casamento do repertório: sem acento, SEM pontuação, espaço
    interno colapsado, maiúscula.

    A planilha escreve a mesma sala como '107 (P2) LAB. METROLOGIA' e
    '107 (P2) - LAB.METROLOGIA', e em 12/08 passou a escrever
    '103 (DESIGN THINKING)' onde o repertório tinha '103 - DESIGN THINKING':
    parêntese, hífen e ponto viravam sala desconhecida, a linha não ocupava nada
    e a sala aparecia livre com aula dentro. Ignorar pontuação mata a classe do
    defeito em vez de cadastrar mais uma variante por vez.

    A BARRA sobrevive de propósito: `resolver_sala` depende dela pra tratar
    rótulo com duas salas concatenadas.
    """
    k = re.sub(r"[().\-]", " ", _sem_acento(texto).upper())
    return re.sub(r"\s+", " ", k).strip()


def carregar_repertorio(caminho=REPERTORIO_PATH):
    """Lê salas-repertorio.json (fonte única, idêntica no repo do v1)."""
    with open(caminho, encoding="utf-8") as f:
        rep = json.load(f)
    # Com chave insensível a pontuação, dois rótulos diferentes podem colapsar na
    # mesma chave. Se apontarem pra salas diferentes é ambiguidade silenciosa, e
    # é melhor a captura morrer aqui do que servir sala errada. A checagem tem
    # que acontecer DURANTE a construção: montar o dict primeiro deixaria o
    # último rótulo sobrescrever o anterior sem ninguém ver.
    visto = {}          # chave -> (origem, rótulo, canônica)

    def registrar(rotulo, canon, origem):
        chave = _chave(rotulo)
        anterior = visto.get(chave)
        if anterior and anterior[2] != canon:
            raise ValueError(
                f"repertório ambíguo: a chave {chave!r} sai de "
                f"{anterior[0]} {anterior[1]!r} -> {anterior[2]!r} e de "
                f"{origem} {rotulo!r} -> {canon!r}"
            )
        visto[chave] = (origem, rotulo, canon)
        return chave

    salas, apelidos, ignoradas = {}, {}, set()
    for s in rep["salas"]:
        salas[registrar(s, s, "canonica")] = s
    for a, c in rep["apelidos"].items():
        apelidos[registrar(a, c, "apelido")] = c
    for i in rep["ignoradas"]:
        ignoradas.add(registrar(i, None, "ignorada"))

    return {
        "salas": salas,
        "predio": dict(rep["salas"]),
        "apelidos": apelidos,
        "ignoradas": ignoradas,
    }


def _lados_da_barra(bruta, rep):
    """Rótulo com barra -> lista de canônicas que cada lado resolve."""
    achadas = []
    for parte in str(bruta).split("/"):
        k = _chave(parte)
        if k in rep["salas"]:
            achadas.append(rep["salas"][k])
        elif k in rep["apelidos"]:
            achadas.append(rep["apelidos"][k])
    # sem duplicata, preservando a ordem em que a planilha escreveu
    return list(dict.fromkeys(achadas))


def resolver_sala(bruta, rep):
    """Grafia crua da planilha -> (canônica, motivo).

    canônica é None quando a linha não ocupa sala nenhuma. Motivos: 'canonica',
    'apelido', 'apelido-barra', 'barra-multipla', 'ignorada', 'vazia',
    'desconhecida'.
    """
    k = _chave(bruta)
    if not k:
        return None, "vazia"
    if k in rep["ignoradas"]:
        return None, "ignorada"
    if k in rep["salas"]:
        return rep["salas"][k], "canonica"
    if k in rep["apelidos"]:
        return rep["apelidos"][k], "apelido"
    if "/" in k:
        # Antes: barra = par concatenado ("302/303"), erro da origem, não ocupa
        # nada. Só que existe rótulo com barra onde UM lado é sala de verdade
        # ("207 (P2) LAB.PROJETOS ELETRICOS/206 (P2)", visto em 12/08): jogar o
        # rótulo inteiro fora deixava a P2-206 livre com aula dentro.
        lados = _lados_da_barra(bruta, rep)
        if len(lados) == 1:
            return lados[0], "apelido-barra"
        if len(lados) > 1:
            # duas salas de verdade concatenadas: ocupar as duas exige coluna
            # nova (mapa_dia.salas_canon) e reverte a decisão de 06/08 sobre par
            # concatenado. Até lá o comportamento não muda, mas o caso é LOGADO
            # em vez de sumir
            return None, "barra-multipla"
        return None, "ignorada"
    return None, "desconhecida"


def anotar_canonicas(linhas, rep):
    """Preenche sala_canon em cada linha. Devolve (pendentes, multiplas):
    grafia desconhecida -> nº de ocorrências (quarentena), e rótulo com barra
    cujos dois lados são sala de verdade -> as canônicas que resolveriam."""
    pendentes = {}
    multiplas = {}
    for l in linhas:
        bruta = str(l.get("sala", "")).strip()
        canon, motivo = resolver_sala(bruta, rep)
        l["sala_canon"] = canon
        if motivo == "desconhecida":
            pendentes[bruta] = pendentes.get(bruta, 0) + 1
        elif motivo == "barra-multipla":
            multiplas[bruta] = _lados_da_barra(bruta, rep)
    return pendentes, multiplas


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
    # revisão humana. `visto_em` entra no payload porque sem ele a coluna guarda
    # o PRIMEIRO avistamento pra sempre, e a quarentena não diz se a grafia
    # ainda aparece na planilha de hoje
    if pendentes:
        agora = datetime.now(BRT).isoformat()
        _post(f"{base}/salas_pendentes", key,
              [{"alias": a, "ocorrencias": n, "visto_em": agora}
               for a, n in pendentes.items()],
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
    pendentes, multiplas = anotar_canonicas(linhas, rep)
    ocupando = sum(1 for l in linhas if l["sala_canon"])
    print(f"{ocupando} linhas ocupam sala do repertório; "
          f"{len(linhas) - ocupando} sem sala (vazia, ignorada ou desconhecida)")
    if pendentes:
        print("quarentena: " + ", ".join(f"{a!r}x{n}" for a, n in pendentes.items()))
    if multiplas:
        print("barra com dois lados válidos (nenhuma sala ocupada, decisão pendente): "
              + ", ".join(f"{a!r} -> {'+'.join(c)}" for a, c in multiplas.items()))

    if os.environ.get("SUPABASE_URL") and os.environ.get("SUPABASE_SERVICE_KEY"):
        enviar(linhas, rep, pendentes)
        print("upsert ok")
    else:
        print("dry-run (sem SUPABASE_URL/SUPABASE_SERVICE_KEY)")
        for l in linhas[:5]:
            print("  ", {k: v for k, v in l.items() if k != "data"})


if __name__ == "__main__":
    main()
