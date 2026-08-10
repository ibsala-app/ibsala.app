"""Testes do parser da captura. Rodar: python3 -m pytest capture/ -q"""

import pytest

from capture.captura import (anotar_canonicas, carregar_repertorio, parsear,
                             resolver_sala)

CSV_DIA_LETIVO = """GRADUAÇÃO - MANHÃ,,,,,
Turma,Disciplina,,Professor,Salas
3IBM,IBM0022-8001/ JURISDICAO E PROCESSO,07:30/09:20,FULANO SILVA,Sala 101
5ECP,IBM0107-3001/ ESTRUTURA DE DADOS,09:50/11:40,OSMAR,Lab 2 (P2)
OUTRAS RESERVAS - NOITE,,,,,
Turma,Disciplina,,Professor,Salas
EVENTO,PALESTRA MAKER,19:00/21:00,,Auditorio
"""

CSV_FERIAS = """GRADUAÇÃO - NOITE,,,,,
Turma,Disciplina,,Professor,Salas
OUTRAS RESERVAS,,,,,
GRADUÇÃO - SÁBADO,,,,,
"""


def test_dia_letivo():
    linhas = parsear(CSV_DIA_LETIVO)
    assert len(linhas) == 3
    assert linhas[0]["codigo"] == "IBM0022-8001"
    assert linhas[0]["disciplina"] == "JURISDICAO E PROCESSO"
    assert linhas[0]["horario"] == "07:30/09:20"
    assert linhas[0]["sala"] == "Sala 101"
    assert linhas[1]["sala"] == "Lab 2 (P2)"
    assert linhas[2]["categoria"] == "OUTRAS RESERVAS - NOITE"
    assert linhas[2]["codigo"] == ""  # sem "/" na disciplina


def test_ferias_sem_lixo():
    # títulos de seção perdidos (inclusive o typo "GRADUÇÃO - SÁBADO" da
    # planilha real) não viram linha do mapa
    assert parsear(CSV_FERIAS) == []


# ── repertório de salas ───────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def rep():
    return carregar_repertorio()


def test_canonica_passa_direto(rep):
    assert resolver_sala("302", rep) == ("302", "canonica")
    assert resolver_sala("  2l1 ", rep) == ("2L1", "canonica")


def test_apelido_vira_canonica(rep):
    # rótulo colado no número: ocupava a sala sem tirá-la da lista de livres
    assert resolver_sala("103 - DESIGN THINKING", rep) == ("103", "apelido")
    assert resolver_sala("113 (PRANCHETAS)", rep) == ("113", "apelido")
    # as grafias da 114 são a mesma sala
    for g in ("114 - LAB QUIMICA", "114 LAB. QUIMICA",
              "114 - LAB. FISICA", "114 LAB. FISICA"):
        assert resolver_sala(g, rep)[0] == "114"


def test_apelido_do_p2_tolera_grafia(rep):
    # espaço interno, ponto e ordem invertida na mesma sala do P2
    for g in ("108 (P2) LAB. HIDRAULICA",
              "108 (P2) LAB.HIDRAULICA E PNEUMATICA",
              "LAB. HIDRAULICA  -  108 (P2)"):
        assert resolver_sala(g, rep)[0] == "P2-108"
    assert resolver_sala("103 (P2) NPJ", rep)[0] == "P2-103"
    assert resolver_sala("HUBS", rep)[0] == "P2-HUBS"
    # quarentena de 07/08: rótulo curto do maker e o lab de maquetes, que é
    # sala nova (não aparecia em quatro meses de captura)
    assert resolver_sala("109 (P2) MAKER", rep)[0] == "P2-109"
    assert resolver_sala("204 (P2) LAB MAQUETES", rep) == ("P2-204", "apelido")


def test_pseudo_sala_nao_ocupa_nem_existe(rep):
    for g in ("CANCELADA", "ONLINE", "Não tem revisão", "VISITA EXTERNA"):
        assert resolver_sala(g, rep) == (None, "ignorada")
    # e nenhuma delas está no repertório, então não vira chip de sala livre
    assert "CANCELADA" not in rep["predio"]
    assert "ONLINE" not in rep["predio"]


def test_concatenada_e_erro_do_sistema(rep):
    # par não existe como sala; a linha não ocupa nada, nem a 302 nem a 303
    assert resolver_sala("302/303", rep) == (None, "ignorada")
    assert resolver_sala("304/035", rep) == (None, "ignorada")
    # regra por barra cobre par novo sem cadastro
    assert resolver_sala("305/306", rep) == (None, "ignorada")


def test_rotulo_com_barra_ganha_da_regra(rep):
    # '/' separando rótulo, não par de salas: a barra não pode engolir a sala,
    # senão a 114 fica livre com aula de física dentro (visto em 10/08)
    assert resolver_sala("114 LAB QUIMICA/FISICA", rep) == ("114", "apelido")


def test_desconhecida_cai_na_quarentena(rep):
    linhas = [
        {"sala": "302"},
        {"sala": "SALA DO CAFE"},
        {"sala": "SALA DO CAFE"},
        {"sala": "CANCELADA"},
        {"sala": ""},
    ]
    pendentes = anotar_canonicas(linhas, rep)
    assert pendentes == {"SALA DO CAFE": 2}
    assert [l["sala_canon"] for l in linhas] == ["302", None, None, None, None]


def test_repertorio_integro(rep):
    # apelido órfão apontaria pra sala inexistente e sumiria da conta
    assert all(c in rep["predio"] for c in rep["apelidos"].values())
    assert not set(rep["apelidos"]) & set(rep["salas"])
    assert len(rep["predio"]) == 59
