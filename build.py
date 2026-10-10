"""Build Kasa Lights: index.html = src/app.html with the shared PHOSPHOR CSS/JS and src/app.js inlined."""
B = '/mnt/project-files/brand/'
h = open('src/app.html').read()
h = h.replace('/*@@PHOSPHOR_CSS@@*/', open(B + 'phosphor.css').read()).replace('/*@@PHOSPHOR_JS@@*/', open(B + 'phosphor.js').read()).replace('/*@@APP_JS@@*/', open('src/app.js').read())
open('index.html', 'w').write(h)
print('index.html', len(h))
