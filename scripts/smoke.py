#!/usr/bin/env python3
"""Smoke do front: sobe a pasta web/ num servidor local, abre no Chrome headless
e afirma no DOM renderizado o que os testes de parser não alcançam.

Existe porque os dois piores defeitos de 12/08 passariam em qualquer suíte de
unidade: a página pintava inteira e NENHUM botão respondia (o módulo morria na
primeira linha, porque o bundle vinha de um CDN que a rede bloqueava), e a tela
de conta ficava em branco esperando JS assíncrono que nunca chegava.

O cenário padrão é o do FIREWALL: o host do Supabase é mapeado pra uma porta
morta, que é a suspeita aberta sobre o WiFi da faculdade. Assim o CI não depende
da produção estar no ar, e ainda cobre a degradação, que é o caminho que mais
quebrou. Com `--online` também confere o caminho feliz contra o banco real.

Uso:
  python3 scripts/smoke.py            # cenário bloqueado (o do CI)
  python3 scripts/smoke.py --online   # também confere com o backend no ar
"""
import http.server
import os
import re
import shutil
import socket
import subprocess
import sys
import threading

RAIZ = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir)
WEB = os.path.join(RAIZ, 'web')
HOST_SUPABASE = 'jbdmkbivmflauushiqca.supabase.co'

CHROMES = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
]


def achar_chrome():
    for c in CHROMES:
        if os.path.exists(c):
            return c
        achado = shutil.which(c)
        if achado:
            return achado
    raise SystemExit('smoke: nenhum Chrome encontrado')


def porta_livre():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def servir(porta):
    class Silencioso(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=WEB, **kw)

        def log_message(self, *a):
            pass

    srv = http.server.ThreadingHTTPServer(('127.0.0.1', porta), Silencioso)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def dom(chrome, url, bloquear_backend):
    args = [
        chrome, '--headless=new', '--disable-gpu', '--no-sandbox',
        '--virtual-time-budget=12000', '--dump-dom', url,
    ]
    if bloquear_backend:
        # mesmo truque que reproduziu o bug dos botões: o host resolve pra uma
        # porta que não escuta, então a requisição falha como numa rede que filtra
        args.insert(-1, f'--host-resolver-rules=MAP {HOST_SUPABASE} 127.0.0.1:1')
    r = subprocess.run(args, capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise SystemExit(f'smoke: chrome falhou ({r.returncode})\n{r.stderr[-800:]}')
    return r.stdout


def conferir(nome, esperado):
    faltando = [d for d, ok in esperado if not ok]
    if faltando:
        print(f'  FALHOU {nome}:')
        for f in faltando:
            print(f'    - {f}')
        return False
    print(f'  ok {nome} ({len(esperado)} afirmações)')
    return True


def texto_de(html, id_):
    m = re.search(rf'id="{id_}"[^>]*>(.*?)<', html, re.S)
    return (m.group(1).strip() if m else '')


def visivel(html, id_):
    """hidden é atributo: o elemento existe no DOM dos dois jeitos."""
    m = re.search(rf'<[^>]*id="{id_}"([^>]*)>', html)
    return bool(m) and 'hidden' not in m.group(1)


def main():
    online = '--online' in sys.argv
    chrome = achar_chrome()
    porta = porta_livre()
    servir(porta)
    url = f'http://127.0.0.1:{porta}/'
    ok = True

    print('smoke: rede da faculdade (backend inalcançável)')
    html = dom(chrome, url, bloquear_backend=True)
    ok &= conferir('degradado', [
        ('o módulo app.js roda até a última linha',
         'data-app="pronto"' in html),
        ('a home mostra o título', 'Salas do Ibmec BH' in html),
        ('os quatro caminhos do menu existem', html.count('class="btn-menu') >= 3),
        ('o cabeçalho vive pelo relógio, sem servidor',
         texto_de(html, 'pill-data') not in ('', '—')),
        ('a tela de conta não fica em branco', visivel(html, 'conta-deslogado')),
        ('existe o botão de entrar', 'id="btn-login"' in html),
        ('o app avisa que não deu pra carregar o mapa', visivel(html, 'agora-falha')),
        ('o app NÃO inventa salas livres', texto_de(html, 'livres-num') in ('–', '-')),
        ('a busca avisa antes de o aluno digitar',
         visivel(html, 'busca-sem-mapa') or 'Busca fora do ar' in html),
        ('termos e privacidade linkados no rodapé da home',
         'href="termos.html"' in html and 'href="privacidade.html"' in html),
    ])

    if online:
        print('smoke: backend no ar')
        html = dom(chrome, url, bloquear_backend=False)
        num = texto_de(html, 'livres-num')
        ok &= conferir('feliz', [
            ('o módulo app.js roda até a última linha', 'data-app="pronto"' in html),
            ('o número de salas livres é um número', num.isdigit()),
            ('a grade de salas foi preenchida', 'class="sala-chip"' in html),
            ('nenhum aviso de falha na tela', not visivel(html, 'agora-falha')),
            ('a pill de frescor diz de quando é o mapa',
             visivel(html, 'pill-frescor') and 'mapa de' in html),
        ])

    print('smoke ok' if ok else 'smoke REPROVOU')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
