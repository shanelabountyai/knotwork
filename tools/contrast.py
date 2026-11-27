"""WCAG 2.1 contrast of Knotwork's token pairs, in both schemes, parsed from src/app/ui/knotwork.css.

Stdlib only. `npm run design:contrast` (python3 -I tools/contrast.py) exits 1 if any pair is under its floor:
4.5:1 for text, 3:1 for control borders and status edges (WCAG 1.4.3 and 1.4.11). It is the evidence behind
docs/DESIGN_SYSTEM.md, not a product file and not an engine oracle (pytest collects only test_*.py here).
The method follows Turnstile's tools/contrast.py: OKLCH -> linear sRGB (Ottosson's matrices), clamped to the gamut,
then the WCAG relative luminance. Alpha in a colour is not modelled; no token uses one for text.
"""
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CSS = open(os.path.join(HERE, '..', 'src', 'app', 'ui', 'knotwork.css'), encoding='utf-8').read()


def oklch_to_linear_rgb(L, C, h):
    a, b = C * math.cos(math.radians(h)), C * math.sin(math.radians(h))
    l_ = L + 0.3963377774 * a + 0.2158037573 * b
    m_ = L - 0.1055613458 * a - 0.0638541728 * b
    s_ = L - 0.0894841775 * a - 1.2914855480 * b
    l, m, s = l_ ** 3, m_ ** 3, s_ ** 3
    r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    return [min(1.0, max(0.0, v)) for v in (r, g, bl)]


def luminance(rgb):
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]


def ratio(a, b):
    hi, lo = sorted((luminance(a), luminance(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def parse_oklch(expr):
    m = re.match(r'oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)', expr.strip())
    if not m:
        raise ValueError(f'not an oklch() literal: {expr!r}')
    return oklch_to_linear_rgb(float(m[1]), float(m[2]), float(m[3]))


def block_after(marker):
    """The text inside the first {...} after `marker`."""
    i = CSS.index('{', CSS.index(marker))
    depth, j = 1, i + 1
    while depth:
        depth += {'{': 1, '}': -1}.get(CSS[j], 0)
        j += 1
    return CSS[i + 1:j - 1]


def tokens(text):
    return dict((k, v.strip()) for k, v in re.findall(r'(--[\w-]+):\s*([^;]+);', text))


def resolve(name, env, depth=0):
    if depth > 8:
        raise ValueError(f'var() loop at {name}')
    v = env[name]
    m = re.fullmatch(r'var\((--[\w-]+)\)', v)
    return resolve(m[1], env, depth + 1) if m else v


primitives = tokens(block_after('/* ============ 1. primitives'))
semantic = tokens(block_after('/* ============ 2. semantic'))
dark_media = tokens(block_after('@media (prefers-color-scheme: dark)'))
dark_attr = tokens(block_after(":root[data-theme='dark']"))
if dark_media != dark_attr:
    print('FAIL the two dark blocks differ (media query and [data-theme=dark]); keep them identical')
    sys.exit(1)

ENVS = {'light': {**primitives, **semantic}}
ENVS['dark'] = {**ENVS['light'], **dark_media}

# Status families: hue and chroma multiplier, as in layer 3.
FAMILIES = {}
for fam, body in re.findall(r"\[data-k='(\w+)'\](?:, \[role='\w+'\])? \{([^}]*)\}", CSS):
    h = re.search(r'--h:\s*([\d.]+)', body)
    cm = re.search(r'--cm:\s*([\d.]+)', body)
    if h:
        FAMILIES[fam] = (float(h[1]), float(cm[1]) if cm else 1.0)
EXPECTED = {'ok', 'late', 'wait', 'info', 'off', 'priv'}
if set(FAMILIES) != EXPECTED:
    print(f'FAIL status families found {sorted(FAMILIES)}, expected {sorted(EXPECTED)}')
    sys.exit(1)

TEXT, UI = 4.5, 3.0
PAIRS = [
    ('ink on page', '--ink', '--bg', TEXT), ('ink on card', '--ink', '--sf', TEXT), ('ink on well', '--ink', '--sf-2', TEXT),
    ('ink on current tab', '--ink', '--ac-tint', TEXT),
    ('muted on page', '--mu', '--bg', TEXT), ('muted on card', '--mu', '--sf', TEXT), ('muted on well', '--mu', '--sf-2', TEXT),
    ('link on page', '--ac', '--bg', TEXT), ('link on card', '--ac', '--sf', TEXT), ('link on well', '--ac', '--sf-2', TEXT),
    ('button text on action', '--acf', '--ac', TEXT),
    ('control border on card (UI)', '--ln-strong', '--sf', UI), ('control border on page (UI)', '--ln-strong', '--bg', UI),
    ('focus ring on page (UI)', '--ac', '--bg', UI), ('focus ring on card (UI)', '--ac', '--sf', UI),
    ('current-tab edge on page (UI)', '--ac', '--bg', UI),
]

bad = 0
for scheme, env in ENVS.items():
    colour = lambda n: parse_oklch(resolve(n, env))
    for label, fg, bg, floor in PAIRS:
        r = ratio(colour(fg), colour(bg))
        ok = r >= floor
        bad += not ok
        print(f'{scheme:5} {"ok " if ok else "LOW"} {r:5.2f}  {label}')
    for fam, (h, cm) in sorted(FAMILIES.items()):
        def k(part):
            return oklch_to_linear_rgb(float(env[f'--k-{part}-l']), float(env[f'--k-{part}-c']) * cm, h)
        checks = [
            (f'{fam}: pill text on pill', k('fg'), k('bg'), TEXT),
            (f'{fam}: pill text on card', k('fg'), colour('--sf'), TEXT) if scheme == 'dark' else None,
            (f'{fam}: pill edge on card (UI)', k('dot'), colour('--sf'), UI),
            (f'{fam}: pill edge on page (UI)', k('dot'), colour('--bg'), UI),
        ]
        for c in filter(None, checks):
            label, a, b, floor = c
            r = ratio(a, b)
            ok = r >= floor
            bad += not ok
            print(f'{scheme:5} {"ok " if ok else "LOW"} {r:5.2f}  {label}')

print('FAIL' if bad else 'OK', bad, 'pairs under floor')
sys.exit(1 if bad else 0)
