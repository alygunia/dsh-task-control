# One-off browser check for dsh-task-control's client half on DSH 0.2.0.
#
# Drives the user's LOCAL Chrome (no bundled Chromium download needed) against
# the running dsh web, then reports:
#   1. whether window.__DSH_BOOT__ exists and contains the dsh-task-control row;
#   2. whether the dock actually mounted ([data-task-control] node + buttons);
#   3. every console line mentioning task-control / slots / ModuleLoader /
#      failed — plus at most 20 unfiltered lines for context.
#
# Usage:  python test/browse-check.py <url-with-token>
#         （URL 是 dsh web 启动时打印的完整地址，仅本机有效）
import json
import sys

from playwright.sync_api import sync_playwright

if len(sys.argv) < 2:
    raise SystemExit("usage: python test/browse-check.py <url-with-token>")
URL = sys.argv[1]
CHROME = r"D:\Apps\chrome-win\chrome.exe"  # user's local Chrome
FILTERS = ("task-control", "task_control", "slot", "moduleloader", "failed", "error")

console = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=CHROME)
    page = browser.new_page()
    page.on("console", lambda m: console.append(f"[{m.type}] {m.text}"))
    page.on("pageerror", lambda e: console.append(f"[pageerror] {e}"))
    page.goto(URL, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_load_state("networkidle", timeout=45000)

    boot = page.evaluate(
        """() => {
            const g = window.__DSH_BOOT__;
            if (!g) return null;
            const rows = g.rows || g.modules || g.entries || [];
            const stringRows = [];
            const scan = (value, path) => {
                if (value === null || typeof value !== 'object') return;
                if (Array.isArray(value)) { value.forEach((v, i) => scan(v, path + '[' + i + ']')); return; }
                for (const [k, v] of Object.entries(value)) {
                    if (typeof v === 'string' && v.includes('task-control')) stringRows.push(path + '.' + k + '=' + v);
                    else if (v && typeof v === 'object') scan(v, path + '.' + k);
                }
            };
            scan(g, 'boot');
            return { keys: Object.keys(g), taskControlMentions: stringRows.slice(0, 12) };
        }"""
    )
    print("BOOT present:", boot is not None)
    if boot:
        print("BOOT keys:", boot["keys"])
        for line in boot["taskControlMentions"]:
            print("  boot:", line[:300])

    dock = page.evaluate(
        """() => ({
            taskControlNodes: document.querySelectorAll('[data-task-control]').length,
            taskControlButtons: document.querySelectorAll('[data-task-control] button').length,
            composerCandidates: Array.from(document.querySelectorAll('[role=group]')).length,
        })"""
    )
    print("DOCK:", json.dumps(dock))

    page.screenshot(path=r"E:\Project\dsh-ext\dsh-task-control\fig\dsh-tc-check.png", full_page=False)
    print("screenshot: fig/dsh-tc-check.png")
    browser.close()

print("\n--- console lines matching the filters ---")
hits = [line for line in console if any(k in line.lower() for k in FILTERS)]
for line in hits[:40]:
    print(line[:500])
print(f"\nmatched {len(hits)} / total {len(console)} console lines")
print("--- first unfiltered lines (context) ---")
for line in console[:20]:
    print(line[:300])
