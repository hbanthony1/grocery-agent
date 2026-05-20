import subprocess, sys

def install(pkg):
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', pkg], stdout=subprocess.DEVNULL)

for pkg in ['markdown', 'xhtml2pdf']:
    install(pkg)

import markdown
from xhtml2pdf import pisa

CSS = """
@page { margin: 1.2in 1.1in; }
body {
    font-family: Georgia, serif;
    font-size: 11pt;
    line-height: 1.65;
    color: #1a1a1a;
}
h1 {
    font-size: 20pt;
    font-weight: bold;
    color: #1a1a1a;
    margin-top: 0;
    margin-bottom: 6pt;
    border-bottom: 2px solid #c48a1a;
    padding-bottom: 6pt;
}
h2 {
    font-size: 14pt;
    font-weight: bold;
    color: #243d2c;
    margin-top: 20pt;
    margin-bottom: 4pt;
}
h3 {
    font-size: 11.5pt;
    font-weight: bold;
    color: #1a1a1a;
    margin-top: 14pt;
    margin-bottom: 3pt;
}
p { margin: 0 0 8pt 0; }
ul, ol { margin: 0 0 8pt 0; padding-left: 20pt; }
li { margin-bottom: 3pt; }
code {
    font-family: Courier, monospace;
    font-size: 9.5pt;
    background: #f4f4f0;
    padding: 1pt 3pt;
}
pre {
    font-family: Courier, monospace;
    font-size: 9pt;
    background: #f4f4f0;
    border-left: 3px solid #c48a1a;
    padding: 8pt 10pt;
    margin: 8pt 0;
    white-space: pre-wrap;
    word-wrap: break-word;
}
pre code { background: none; padding: 0; }
hr {
    border: none;
    border-top: 1px solid #ddd;
    margin: 16pt 0;
}
strong { font-weight: bold; }
em { font-style: italic; }
blockquote {
    border-left: 3px solid #c48a1a;
    margin: 8pt 0 8pt 12pt;
    padding-left: 10pt;
    color: #444;
}
"""

files = [
    ('BUILD_GUIDE_BEGINNER.md',  'BUILD_GUIDE_BEGINNER.pdf'),
    ('BUILD_GUIDE_CHAT_ONLY.md', 'BUILD_GUIDE_CHAT_ONLY.pdf'),
]

for md_file, pdf_file in files:
    with open(md_file, encoding='utf-8') as f:
        md_text = f.read()

    html_body = markdown.markdown(md_text, extensions=['fenced_code', 'tables'])
    html = f'<html><head><style>{CSS}</style></head><body>{html_body}</body></html>'

    with open(pdf_file, 'wb') as out:
        result = pisa.CreatePDF(html, dest=out)

    if result.err:
        print(f'ERROR: {pdf_file}')
    else:
        print(f'Created: {pdf_file}')
