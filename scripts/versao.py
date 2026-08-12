#!/usr/bin/env python3
"""Checa que HTML, JS, CSS e service worker apontam pra MESMA versão de asset.

Existe por causa do IBSALA-F (12/08): o `btn-push` virou `chk-push` no #22, os
dois arquivos mudaram no mesmo commit, e mesmo assim o celular do aluno rodou o
app.js de antes contra o index.html de depois. O Cloudflare Pages devolve
`max-age=14400` em js e css da RAIZ e não aceita o `_headers` por cima (três
medições em produção), então quem não tem service worker controlando a página
fica com o JS de até 4 horas atrás. O conserto é endereço novo a cada deploy
(`?v=N`), e este script é quem garante que o N não fica pra trás em nenhum dos
quatro arquivos.

O CACHE do sw.js é a fonte de verdade do N, porque bumpá-lo já era o ritual do
projeto. A diferença é que agora ele é conferido em vez de lembrado.

Uso: python3 scripts/versao.py           (exit 1 se reprovar)
     python3 scripts/versao.py --base origin/main
"""
import os
import re
import subprocess
import sys

RAIZ = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir)
# mexer em qualquer um destes obriga a subir o N: são os arquivos que o navegador
# guarda por endereço e que o HTML precisa achar em par
VERSIONADOS = ['web/app.js', 'web/style.css', 'web/config.js', 'web/index.html',
               'web/privacidade.html', 'web/termos.html']


def ler(caminho):
    with open(os.path.join(RAIZ, caminho), encoding='utf-8') as f:
        return f.read()


def versao_do_sw(texto):
    m = re.search(r"CACHE\s*=\s*'ibsala-v5-(\d+)'", texto)
    return int(m.group(1)) if m else None


def git(*args):
    """Devolve stdout, ou None se o comando falhar (repo raso, sem base)."""
    try:
        r = subprocess.run(['git', '-C', RAIZ, *args],
                           capture_output=True, text=True, check=True)
        return r.stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def conferir(nome, esperado):
    print(f'  {"ok " if esperado else "FALHA"}  {nome}')
    return esperado


def main():
    base = None
    if '--base' in sys.argv:
        base = sys.argv[sys.argv.index('--base') + 1]

    sw = ler('web/sw.js')
    n = versao_do_sw(sw)
    if n is None:
        print("versao: não achei CACHE = 'ibsala-v5-N' em web/sw.js")
        sys.exit(1)

    html = ler('web/index.html')
    app = ler('web/app.js')
    ok = True

    print(f'versao: sw.js diz N={n}')
    ok &= conferir(f'index.html carrega app.js?v={n}',
                   f'src="app.js?v={n}"' in html)
    ok &= conferir(f'index.html carrega style.css?v={n}',
                   f'href="style.css?v={n}"' in html)
    ok &= conferir(f'app.js importa ./config.js?v={n}',
                   f"'./config.js?v={n}'" in app)
    # as duas páginas soltas entram porque o SHELL do sw.js agora guarda
    # `/style.css?v=N`: deixar elas pedindo `/style.css` cru é página sem estilo
    # nenhum quando o aluno abre offline
    for pagina in ('web/privacidade.html', 'web/termos.html'):
        ok &= conferir(f'{pagina} carrega style.css?v={n}',
                       f'href="style.css?v={n}"' in ler(pagina))
    # o SHELL sai do próprio CACHE (`const V = CACHE.split('-').pop()`); se alguém
    # voltar a escrever o caminho cru, o precache deixa de casar com o pedido real
    ok &= conferir('sw.js monta o SHELL a partir do CACHE',
                   "CACHE.split('-').pop()" in sw and '`/app.js?v=${V}`' in sw)

    if base:
        alterados = git('diff', '--name-only', f'{base}...HEAD')
        if alterados is None:
            print(f'  --   sem {base} pra comparar: pulando a checagem de bump')
        else:
            tocou = [f for f in VERSIONADOS if f in alterados.split()]
            if not tocou:
                print('  --   nenhum arquivo versionado mudou: bump não é exigido')
            else:
                antes = git('show', f'{base}:web/sw.js')
                n_antes = versao_do_sw(antes) if antes else None
                ok &= conferir(
                    f'{", ".join(tocou)} mudou, então N subiu ({n_antes} -> {n})',
                    n_antes is not None and n > n_antes)

    print('versao ok' if ok else 'versao REPROVOU')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
