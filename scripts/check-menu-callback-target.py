"""Compile the actual SWF event wrapper and exercise callbacks after row deletion.

Unlike the dispatch-order fixture, this retains the script callback after the
widget is freed, then reuses exactly the same widget address.
"""
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
menu = root / 'engine/chocolate-doom3-bfg/neo/d3xp/menus'
header = (menu / 'MenuWidget.h').read_text(encoding='utf-8')
source = (menu / 'MenuWidget.cpp').read_text(encoding='utf-8')
start = header.index('    struct EventTarget {')
wrappers = header[start:header.index('    enum widgetState_t', start)]
start = source.index('idMenuWidget::~idMenuWidget()')
invalidation = source[source.index('{', start) + 1:source.index('    Cleanup();', start)]
assert 'eventTarget = new (TAG_SWF) EventTarget(this);' in source
assert 'idMenuWidget* targetWidget = target->widget;' in header
assert 'if (!targetWidget) return idSWFScriptVar();' in header
fixture = r'''
#include <cassert>
#include <new>
#include <cstdio>
struct idSWFScriptObject {};
struct idSWFParmList {};
struct idSWFScriptVar {};
struct idSWFScriptFunction_RefCounted { virtual ~idSWFScriptFunction_RefCounted() {} };
enum widgetEvent_t { PRESS, RELEASE, ROLL_OVER, ROLL_OUT };
struct idWidgetEvent { idWidgetEvent(widgetEvent_t, int, idSWFScriptObject*, const idSWFParmList&) {} };
int dispatched = 0;
class idMenuWidget {
public:
''' + wrappers + r'''
  EventTarget* eventTarget;
  idMenuWidget() { eventTarget = new EventTarget(this); }
  ~idMenuWidget() {
''' + invalidation + r'''
  }
  void ReceiveEvent(const idWidgetEvent&) { ++dispatched; }
};
int main() {
  for (widgetEvent_t event : {PRESS, RELEASE, ROLL_OVER, ROLL_OUT}) {
    alignas(idMenuWidget) unsigned char slot[sizeof(idMenuWidget)];
    auto* widget = new (slot) idMenuWidget;
    auto* callback = new idMenuWidget::WrapWidgetSWFEvent(widget, event, 0);
    callback->Call(nullptr, {});
    const int before = dispatched;
    widget->~idMenuWidget();
    callback->Call(nullptr, {});
    assert(dispatched == before);
    auto* replacement = new (slot) idMenuWidget;
    callback->Call(nullptr, {});
    assert(dispatched == before); // old pointer address must not target the new row
    auto* current = new idMenuWidget::WrapWidgetSWFEvent(replacement, event, 0);
    current->Call(nullptr, {});
    assert(dispatched == before + 1);
    delete callback;
    replacement->~idMenuWidget();
    current->Call(nullptr, {});
    assert(dispatched == before + 1);
    delete current;
  }
  std::puts("SWF callbacks after widget deletion/address reuse are ignored; live callbacks still dispatch.");
}
'''
fixture = fixture.replace('#include <new>', '#include <new>\n#include <initializer_list>')
compiler = shutil.which('clang++') or shutil.which('g++')
if not compiler:
    raise SystemExit('C++ compiler required')
with tempfile.TemporaryDirectory(prefix='doom-menu-target-') as directory:
    path = Path(directory)
    cpp = path / 'check.cpp'
    cpp.write_text(fixture, encoding='utf-8')
    exe = path / 'check.exe'
    subprocess.run([compiler, '-std=c++17', str(cpp), '-o', str(exe)], check=True)
    subprocess.run([str(exe)], check=True)
