#!/usr/bin/env python3
"""Checa contraste dos pares texto/fundo declarados no web/style.css.

Existe porque o dark mode já entregou texto branco sobre azul claro a 3,4:1 (a
pill de data), e olho nu não pega isso. Lê os tokens das duas paletas do próprio
CSS, então recolorir o tema quebra o teste em vez de quebrar o aluno.

Uso: python3 scripts/contraste.py   (exit 1 se algum par reprovar)
"""
import os
import re
import sys

CSS = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir, 'web', 'style.css')

# (onde aparece, token do texto, token do fundo, mínimo exigido)
# 4.5 = texto normal (WCAG AA). 3.0 = texto grande: >=24px, ou >=18.66px negrito.
PARES = [
    ('body', 'text', 'bg', 4.5),
    ('board .disc', 'text', 'surface', 4.5),
    ('board .meta', 'text-muted', 'surface', 4.5),
    ('hero-rotulo', 'text-dim', 'surface', 4.5),
    ('hero-num (56px)', 'blue', 'surface', 3.0),
    ('marca-nome (20px/900)', 'blue', 'surface', 3.0),
    ('board .sala (17px/800)', 'blue', 'gold-soft', 3.0),
    ('board .sala-vazia', 'text-dim', 'bg2', 4.5),
    ('sala-chip', 'text', 'bg2', 4.5),
    ('mini', 'text', 'bg2', 4.5),
    ('pill', 'text-dim', 'bg2', 4.5),
    ('pill-azul', 'sobre-azul', 'blue-2', 4.5),
    ('pill-ouro', 'sobre-ouro', 'gold', 4.5),
    ('pill-fraco', 'text-muted', 'bg', 4.5),
    ('btn-menu', 'text', 'surface', 4.5),
    ('btn-menu.primario', 'sobre-ouro', 'gold', 4.5),
    ('btn-menu.menor', 'text-dim', 'bg', 4.5),
    ('botao-raso', 'text-dim', 'surface', 4.5),
    ('botao-primario', 'sobre-ouro', 'gold', 4.5),
    ('eyebrow', 'gold-texto', 'bg', 4.5),
    ('tagline', 'text-dim', 'bg', 4.5),
    ('secao', 'text-muted', 'bg', 4.5),
    ('vazio', 'text-muted', 'bg', 4.5),
    ('cta-suave', 'text-dim', 'bg2', 4.5),
    ('falha', 'text', 'aviso-soft', 4.5),
    ('perigo (excluir conta)', 'perigo', 'surface', 4.5),
    ('erro de formulario', 'perigo', 'bg', 4.5),
    ('dica', 'text-dim', 'bg', 4.5),
    ('dia-chip', 'text-dim', 'bg2', 4.5),
    ('pill-dia', 'text-dim', 'bg2', 4.5),
    ('pill-escolha.escolhida', 'sobre-azul', 'blue-2', 4.5),
    ('mini.perigo (Remover mesmo?)', 'perigo', 'bg2', 4.5),
    ('rodape', 'text-muted', 'bg', 4.5),
    ('voltar', 'text-dim', 'bg', 4.5),
    ('grupo-rotulo', 'text-muted', 'surface', 4.5),
    ('rotulo-campo', 'text-muted', 'bg', 4.5),
    ('input', 'text', 'surface', 4.5),
    ('link-botao', 'blue-2', 'bg2', 4.5),
    ('bloqueio-card p', 'text-dim', 'surface', 4.5),
    # pós-graduação: a fonte da coordenação da pós, em vermelho. A cor nunca é o
    # único sinal (a etiqueta PÓS acompanha), mas o contraste tem que fechar
    # igual, nos dois temas.
    ('etiqueta PÓS', 'pos-sobre-vermelho', 'pos-vermelho', 4.5),
    ('cartão pós .disc', 'text', 'pos-suave', 4.5),
    ('cartão pós .meta', 'text-muted', 'pos-suave', 4.5),
    ('cartão pós .curso', 'pos-texto', 'pos-suave', 4.5),
]


TOKEN = r'--([\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;'


def ler_paletas(caminho):
    css = open(caminho, encoding='utf-8').read()
    # :root base
    base = re.search(r':root\s*\{(.*?)\}', css, re.S).group(1)
    claro = dict(re.findall(TOKEN, base))

    # A paleta escura mora em DOIS blocos: o do sistema
    # (`:root:not([data-tema="claro"])` dentro do @media) e o da escolha manual
    # (`:root[data-tema="escuro"]`). Sem build step não dá pra ter uma fonte só,
    # então aqui os dois são lidos e comparados: divergência reprova o CI, senão
    # um conserto de contraste entra num tema e esquece o outro.
    sistema = re.search(
        r'@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-tema="claro"\]\)\s*\{(.*?)\n  \}',
        css, re.S)
    manual = re.search(r':root\[data-tema="escuro"\]\s*\{(.*?)\n\}', css, re.S)
    if not sistema or not manual:
        raise SystemExit('nao achei as duas paletas escuras (@media e [data-tema="escuro"])')

    t_sistema = dict(re.findall(TOKEN, sistema.group(1)))
    t_manual = dict(re.findall(TOKEN, manual.group(1)))
    if t_sistema != t_manual:
        difs = {k for k in set(t_sistema) | set(t_manual)
                if t_sistema.get(k) != t_manual.get(k)}
        raise SystemExit('paletas escuras divergem em: ' + ', '.join(sorted(difs)))

    escuro = dict(claro)
    escuro.update(t_sistema)
    return {'claro': claro, 'escuro': escuro}


def rgb(hexa):
    h = hexa.lstrip('#')
    if len(h) == 3:
        h = ''.join(c * 2 for c in h)
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def luminancia(cor):
    def canal(v):
        v /= 255
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = (canal(c) for c in rgb(cor))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def razao(a, b):
    la, lb = luminancia(a), luminancia(b)
    claro, escuro = max(la, lb), min(la, lb)
    return (claro + 0.05) / (escuro + 0.05)


def main():
    paletas = ler_paletas(CSS)
    falhas = []
    for tema, tokens in paletas.items():
        print(f'\n── tema {tema} ' + '─' * 40)
        for onde, t_txt, t_bg, minimo in PARES:
            if t_txt not in tokens or t_bg not in tokens:
                falhas.append(f'{tema}/{onde}: token ausente ({t_txt} ou {t_bg})')
                continue
            r = razao(tokens[t_txt], tokens[t_bg])
            ok = r >= minimo
            marca = 'ok  ' if ok else 'FALHA'
            print(f'  {marca} {r:5.2f}:1 (min {minimo}) {onde}  [{t_txt} on {t_bg}]')
            if not ok:
                falhas.append(f'{tema}/{onde}: {r:.2f}:1 < {minimo} ({tokens[t_txt]} on {tokens[t_bg]})')

    print()
    if falhas:
        print(f'{len(falhas)} par(es) reprovado(s):')
        for f in falhas:
            print('  -', f)
        return 1
    print(f'{len(PARES) * 2} pares conferidos nos dois temas, todos acima do mínimo.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
