#!/usr/bin/env python3
"""Portão de paridade: o parser em Python e a edge function em TS têm que
devolver o MESMO payload pro mesmo CSV.

Existe porque a captura foi portada pra TypeScript (o agendador virou pg_cron,
já que o schedule do Actions entrega 6 a 10 execuções por dia no lugar de 48), e
um porte de parser é exatamente onde defeito como o da 114 volta: sala que
aparece livre com aula dentro. Sem diff vazio aqui, o cron não vira.

Uso:
  python3 scripts/paridade-captura.py                 # baixa a planilha de hoje
  python3 scripts/paridade-captura.py fixture.csv     # usa um CSV salvo

Ambiente: SUPABASE_URL, CRON_SECRET (de ~/.claude/secrets/ibsala-supabase.env)
"""
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir))

from capture.captura import (anotar_canonicas, baixar_csv,  # noqa: E402
                            carregar_repertorio, parsear)


def payload_python(texto):
    linhas = parsear(texto)
    rep = carregar_repertorio()
    pendentes, multiplas = anotar_canonicas(linhas, rep)
    disc = sorted({l["codigo"] for l in linhas if l["codigo"]})
    return {
        "linhas": len(linhas),
        "ocupando": sum(1 for l in linhas if l["sala_canon"]),
        "quarentena": len(pendentes),
        "linhas_detalhe": linhas,
        "disciplinas": disc,
        "pendentes": pendentes,
        "multiplas": multiplas,
    }


def payload_ts(texto):
    url = os.environ["SUPABASE_URL"].rstrip("/") + "/functions/v1/captura"
    req = urllib.request.Request(
        url,
        data=json.dumps({"dry": True, "csv": texto}).encode(),
        headers={
            "Content-Type": "application/json",
            "x-cron-secret": os.environ["CRON_SECRET"],
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.load(resp)


def comparar(py, ts):
    difs = []
    for campo in ("linhas", "ocupando", "quarentena"):
        if py[campo] != ts.get(campo):
            difs.append(f"{campo}: python={py[campo]} ts={ts.get(campo)}")

    if py["disciplinas"] != ts.get("disciplinas"):
        so_py = set(py["disciplinas"]) - set(ts.get("disciplinas") or [])
        so_ts = set(ts.get("disciplinas") or []) - set(py["disciplinas"])
        difs.append(f"disciplinas: só no python={sorted(so_py)} só no ts={sorted(so_ts)}")

    if py["pendentes"] != ts.get("pendentes"):
        difs.append(f"quarentena: python={py['pendentes']} ts={ts.get('pendentes')}")

    if py["multiplas"] != ts.get("multiplas"):
        difs.append(f"barra múltipla: python={py['multiplas']} ts={ts.get('multiplas')}")

    a, b = py["linhas_detalhe"], ts.get("linhas_detalhe") or []
    if len(a) != len(b):
        difs.append(f"nº de linhas do detalhe: python={len(a)} ts={len(b)}")
    for i, (la, lb) in enumerate(zip(a, b)):
        for campo in ("data", "categoria", "turma", "codigo", "disciplina",
                      "horario", "professor", "sala", "sala_canon"):
            if la.get(campo) != lb.get(campo):
                difs.append(
                    f"linha {i} campo {campo}: python={la.get(campo)!r} ts={lb.get(campo)!r}")
    return difs


def main():
    texto = open(sys.argv[1], encoding="utf-8").read() if len(sys.argv) > 1 else baixar_csv()
    print(f"CSV com {len(texto)} caracteres\n")

    py = payload_python(texto)
    print(f"python: {py['linhas']} linhas, {py['ocupando']} ocupando, "
          f"{py['quarentena']} em quarentena, {len(py['disciplinas'])} disciplinas")

    ts = payload_ts(texto)
    print(f"ts:     {ts.get('linhas')} linhas, {ts.get('ocupando')} ocupando, "
          f"{ts.get('quarentena')} em quarentena, {len(ts.get('disciplinas') or [])} disciplinas\n")

    difs = comparar(py, ts)
    if difs:
        print(f"PARIDADE REPROVADA, {len(difs)} diferença(s):")
        for d in difs[:40]:
            print("  -", d)
        if len(difs) > 40:
            print(f"  ... e mais {len(difs) - 40}")
        return 1
    print("paridade ok: payload idêntico campo a campo, linha a linha.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
