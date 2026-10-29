"""Compile real native profile editing/masking methods against UI/event fakes."""
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
source = (root / 'engine/chocolate-doom3-bfg/neo/d3xp/menus/MenuScreen_Shell_WebSettings.cpp').read_text(encoding='utf-8')
def extract(signature):
    start = source.index(signature)
    brace = source.index('{', start)
    depth, end = 1, brace + 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[start:end]

fixture = r'''
#include <cassert>
#include <cstdarg>
#include <cstdio>
#include <string>
int Min(int a, int b) { return a < b ? a : b; }
const char* va(const char* format, ...) {
    static char buffers[4][2048]; static int slot = 0;
    char* out = buffers[(slot++) % 4]; va_list args; va_start(args, format);
    std::vsnprintf(out, 2048, format, args); va_end(args); return out;
}
struct idStr : std::string {
    using std::string::string; using std::string::operator=;
    int Length() const { return static_cast<int>(size()); }
    void Clear() { clear(); }
    void CapLength(int length) { resize(length); }
    void Append(char value) { push_back(value); }
    void AppendUTF8Char(unsigned int c) {
        if (c < 128) push_back(c);
        else if (c < 2048) { push_back(0xC0 | (c >> 6)); push_back(0x80 | (c & 63)); }
        else if (c < 65536) { push_back(0xE0 | (c >> 12)); push_back(0x80 | ((c >> 6) & 63)); push_back(0x80 | (c & 63)); }
        else { push_back(0xF0 | (c >> 18)); push_back(0x80 | ((c >> 12) & 63)); push_back(0x80 | ((c >> 6) & 63)); push_back(0x80 | (c & 63)); }
    }
};
enum { SE_KEY, SE_CHAR, K_ESCAPE = 27, K_ENTER = 13, K_KP_ENTER = 269, K_TAB = 9, K_BACKSPACE = 8, SHELL_AREA_BROWSER_SETTINGS = 7 };
struct sysEvent_t { int evType, evValue, evValue2; };
struct Menu { int ActiveScreen() { return SHELL_AREA_BROWSER_SETTINGS; } };
struct Options { int updates = 0; void Update() { ++updates; } };
struct Control { std::string label; void SetLabel(const char* value) { label = value; } };
struct idMenuScreen_Shell_WebSettings {
    Menu* menuData; Options* options;
    int profileEditing = -1, profileReleaseKey = 0;
    idStr profileFields[5], profileEditOriginal;
    Control* profileFieldControls[5] = {};
    void UpdateProfileField(int);
    bool HandleBrowserInput(const sysEvent_t*);
};
''' + extract('void idMenuScreen_Shell_WebSettings::UpdateProfileField(int field)') + '\n' + extract('bool idMenuScreen_Shell_WebSettings::HandleBrowserInput(const sysEvent_t* event)') + r'''
int main() {
    Menu menu; Options options; Control controls[5];
    idMenuScreen_Shell_WebSettings page; page.menuData = &menu; page.options = &options;
    for (int i = 0; i < 5; ++i) page.profileFieldControls[i] = &controls[i];
    auto send = [&](int type, int value, int down = 0) { sysEvent_t e{type, value, down}; return page.HandleBrowserInput(&e); };
    assert(!send(SE_CHAR, 'A'));
    page.profileEditing = 0; page.profileFields[0] = "Original"; page.profileEditOriginal = page.profileFields[0];
    assert(send(SE_CHAR, '|') && page.profileFields[0] == "Original|");
    assert(send(SE_KEY, K_ESCAPE, 1) && page.profileFields[0] == "Original");
    assert(page.profileEditing == -1 && send(SE_KEY, K_ESCAPE, 0));
    assert(!send(SE_KEY, K_ESCAPE, 1));
    page.profileEditing = 0; page.profileFields[0] = "A";
    assert(send(SE_CHAR, 0x20AC) && page.profileFields[0].Length() == 4);
    assert(send(SE_KEY, K_BACKSPACE, 1) && page.profileFields[0] == "A");
    page.profileFields[0] = std::string(48, 'x');
    assert(send(SE_CHAR, 'y') && page.profileFields[0].Length() == 48);
    page.profileEditing = 2; page.profileFields[2] = "fixture-secret";
    assert(send(SE_CHAR, ' ') && page.profileFields[2] == "fixture-secret ");
    page.UpdateProfileField(2);
    assert(controls[2].label.find("fixture-secret") == std::string::npos && controls[2].label.find('*') != std::string::npos);
    assert(send(SE_KEY, K_ENTER, 1) && page.profileEditing == -1);
    assert(send(SE_KEY, K_ENTER, 0));
    assert(!send(SE_CHAR, 'z'));
    std::puts("Native profile input: masking, spaces, UTF-8/backspace, limits and Enter/Esc release consumption passed.");
}
'''
compiler = shutil.which('clang++') or shutil.which('g++')
if not compiler:
    raise SystemExit('A C++ compiler is required for this focused check.')
with tempfile.TemporaryDirectory(prefix='doom-native-profile-') as folder:
    temp = Path(folder)
    cpp, exe = temp / 'check.cpp', temp / 'check.exe'
    cpp.write_text(fixture, encoding='utf-8')
    subprocess.run([compiler, '-std=c++17', str(cpp), '-o', str(exe)], check=True, timeout=60)
    subprocess.run([str(exe)], check=True, timeout=20)
