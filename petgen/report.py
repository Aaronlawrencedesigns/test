"""QA report for one pet: what was made, what passed, what was retried, estimated cost."""
import base64, html, os, time

from . import plan


def _img(path, width=None):
    if not path or not os.path.exists(path):
        return '<span class="missing">missing</span>'
    ext = 'jpeg' if path.endswith(('.jpg', '.jpeg')) else ('webp' if path.endswith('.webp') else 'png')
    data = base64.b64encode(open(path, 'rb').read()).decode()
    w = f' width="{width}"' if width else ''
    return f'<img src="data:image/{ext};base64,{data}"{w} alt="">'


def write_report(job):
    cost = job.cost['images'] * plan.PRICE_IMAGE + job.cost['video_seconds'] * plan.PRICE_VIDEO_PER_SECOND
    final = {}
    for q in job.qa:
        final[q['item']] = q            # last attempt per item
    retried = sorted({q['item'] for q in job.qa if q['attempt'] > 1})
    failed = [k for k, q in final.items() if q['problems'] and not k.startswith('photo')]
    warnings = [k for k, q in final.items() if q['problems'] and k.startswith('photo')]
    ok = job.error is None and not failed
    verdict = ('Ready to ship' if ok and not warnings else 'Ready, with photo warnings' if ok else
               'Needs review' if job.error is None else 'Failed')
    rows = []
    for q in job.qa:
        m = ', '.join(f'{k} {v}' for k, v in q['metrics'].items() if not isinstance(v, (list, dict)) or k == 'size')
        rows.append(f'<tr class="{"bad" if q["problems"] else "ok"}"><td>{html.escape(q["item"])}</td><td>{q["attempt"]}</td>'
                    f'<td>{"pass" if not q["problems"] else html.escape("; ".join(q["problems"]))}</td><td class="m">{html.escape(m)}</td></tr>')
    sheets = ''
    sd = f'{job.work}/sheets'
    if os.path.isdir(sd):
        for f in sorted(os.listdir(sd)):
            sheets += f'<figure><figcaption>{html.escape(os.path.splitext(f)[0].replace("_", " "))}</figcaption>{_img(os.path.join(sd, f))}</figure>'
    kfs = ''.join(f'<figure><figcaption>{n}</figcaption>{_img(f"{job.pet}/stills/{n}.webp", 200)}</figure>' for n in ('sit', 'lie', 'sleep'))
    master = _img(job._gen_path('master', 1, 'png'), 240)
    page = f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(job.name)}: petgen report</title>
<style>
:root{{--bg:#f4f2f6;--fg:#231f27;--muted:#6c6474;--ok:#1f7a4d;--bad:#b3261e;--card:#fff;--line:#e2dce6}}
body{{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,system-ui,sans-serif;padding:24px max(16px,4vw)}}
h1{{margin:0 0 4px;font-size:28px}} h2{{margin:28px 0 10px;font-size:18px}}
.verdict{{display:inline-block;padding:4px 10px;border-radius:999px;font-weight:600;background:{'#dff3e8' if ok else '#fbe3e1'};color:{'var(--ok)' if ok else 'var(--bad)'}}}
.stats{{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0}} .stats div{{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 12px}}
.stats b{{display:block;font-size:18px}}
table{{border-collapse:collapse;width:100%;background:var(--card);border-radius:10px;overflow:hidden}} td{{padding:6px 10px;border-top:1px solid var(--line);vertical-align:top}}
tr.bad td:nth-child(3){{color:var(--bad)}} tr.ok td:nth-child(3){{color:var(--ok)}} td.m{{color:var(--muted);font-size:12px}}
figure{{margin:0 0 14px}} figcaption{{color:var(--muted);font-size:12px;margin-bottom:4px}} img{{max-width:100%;border-radius:8px;background:#e6e3ea}}
.row{{display:flex;flex-wrap:wrap;gap:14px}} .missing{{color:var(--bad)}} .err{{background:#fbe3e1;color:var(--bad);padding:10px;border-radius:8px}}
</style></head><body>
<h1>{html.escape(job.name)}</h1>
<span class="verdict">{verdict}</span>
{f'<p class="err">{html.escape(job.error)}</p>' if job.error else ''}
<div class="stats">
 <div><b>${cost:.2f}</b>est. AI cost</div>
 <div><b>{job.cost['images']}</b>images made</div>
 <div><b>{job.cost['video_seconds']} s</b>video made</div>
 <div><b>{job.cost['cached']}</b>reused from cache</div>
 <div><b>{len(retried)}</b>items retried</div>
 <div><b>{int(time.time() - job.t0)} s</b>run time</div>
</div>
{f'<p>Needs a look: {html.escape(", ".join(failed))}</p>' if failed else ''}
{f'<p>Photo warnings: {html.escape(", ".join(warnings))}</p>' if warnings else ''}
<h2>Portrait and poses</h2><div class="row"><figure><figcaption>portrait</figcaption>{master}</figure>{kfs}</div>
<h2>Clips and head tracking</h2>{sheets}
<h2>Quality checks</h2><table>{''.join(rows)}</table>
</body></html>"""
    open(f'{job.out}/report.html', 'w').write(page)
    job.log(f'report: {job.out}/report.html  ({verdict}, est. ${cost:.2f})')
