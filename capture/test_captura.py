"""Testes do parser da captura. Rodar: python3 -m pytest capture/ -q"""

from capture.captura import parsear

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
