const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const rootMenu = source('engine/chocolate-doom3-bfg/neo/d3xp/menus/MenuScreen_Shell_Root.cpp');
const menuBar = source('engine/chocolate-doom3-bfg/neo/d3xp/menus/MenuWidget_MenuBar.cpp');
const handler = source('engine/chocolate-doom3-bfg/neo/d3xp/menus/MenuHandler_Shell.cpp');
const settings = source('engine/chocolate-doom3-bfg/neo/d3xp/menus/MenuScreen_Shell_Settings.cpp');
const system = source('engine/chocolate-doom3-bfg/neo/d3xp/menus/MenuScreen_Shell_SystemOptions.cpp');
const webSettings = source('engine/chocolate-doom3-bfg/neo/d3xp/menus/MenuScreen_Shell_WebSettings.cpp');
const multiplayer = source('engine/chocolate-doom3-bfg/neo/d3xp/menus/MenuScreen_Shell_WebMultiplayer.cpp');
const screenHeader = source('engine/chocolate-doom3-bfg/neo/d3xp/menus/MenuScreen.h');
const handlerHeader = source('engine/chocolate-doom3-bfg/neo/d3xp/menus/MenuHandler.h');

function extractBlock(text, marker) {
  const at = text.indexOf(marker);
  assert.notEqual(at, -1, `missing source marker: ${marker}`);
  const open = text.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}' && --depth === 0) return text.slice(at, i + 1);
  }
  assert.fail(`unterminated source block: ${marker}`);
}

const countBlock = extractBlock(menuBar, 'int idMenuWidget_MenuBar::GetTotalNumberOfOptions() const');
assert.match(countBlock, /return headings\.Num\(\);/, 'navigation count uses active headings, not allocated button slots');
const getHeadingCount = new Function('headings', 'return headings.Num();');
const fiveItems = getHeadingCount({ Num: () => 5 });
assert.equal(fiveItems, 5);

const wrapPattern = /index \+= dir;\s*if \(index < 0\) \{\s*index = totalCount - 1;\s*\} else if \(index >= totalCount\) \{\s*index = 0;\s*\}/;
const wrapBlock = rootMenu.match(wrapPattern)?.[0];
assert.ok(wrapBlock, 'root menu uses the two-ended wrap formula');
assert.match(rootMenu, /const int totalCount = menuBar->GetTotalNumberOfOptions\(\);\s*if \(totalCount <= 0\)/,
  'root navigation wraps using the actual heading count');
const wrapIndex = new Function('index', 'dir', 'totalCount', `${wrapBlock}\nreturn index;`);
assert.equal(wrapIndex(0, -1, fiveItems), 4, 'left from Campaign wraps to Quit');
assert.equal(wrapIndex(4, 1, fiveItems), 0, 'right from Quit wraps to Campaign');
assert.equal(wrapIndex(2, 1, fiveItems), 3, 'interior right navigation advances normally');

assert.match(handlerHeader, /SHELL_AREA_BROWSER_SETTINGS,\s*SHELL_AREA_EXTRAS,/,
  'Extras has a distinct native menu area');
assert.match(handler, /BIND_WEB_SETTINGS\(SHELL_AREA_BROWSER_SETTINGS, PAGE_BROWSER, this\);\s*BIND_WEB_SETTINGS\(SHELL_AREA_EXTRAS, PAGE_EXTRAS, this\);/,
  'Browser and Extras each bind the existing native SWF settings page');
assert.match(settings, /"Video", "Audio", "Browser", "Extras"/,
  'Settings exposes Browser and the new Extras entry');
assert.match(settings, /SETTING_CMD_EXTRAS[\s\S]*?SetNextScreen\(SHELL_AREA_EXTRAS/,
  'the Extras row opens its native page');

const rowsStart = webSettings.indexOf('if (page == PAGE_VIDEO)');
const rowsEnd = webSettings.indexOf('options->AddEventAction(WIDGET_EVENT_SCROLL_DOWN)', rowsStart);
assert.ok(rowsStart >= 0 && rowsEnd > rowsStart, 'settings page row construction exists');
const browserRows = webSettings.slice(rowsStart, rowsEnd);
assert.match(browserRows, /else if \(page == PAGE_BROWSER\)[\s\S]*BuildBrowserRows\(\)/);
const accountRows = webSettings.slice(webSettings.indexOf('void idMenuScreen_Shell_WebSettings::RebuildBrowserRows()'),
  webSettings.indexOf('void idMenuScreen_Shell_WebSettings::Update()'));
assert.match(accountRows, /Manage profile:[\s\S]*Clear all local data[\s\S]*Delete account/,
  'Browser exposes account management and local storage');
assert.doesNotMatch(accountRows, /Account saves:/, 'automatic saves need no redundant settings row');
assert.match(accountRows, /Save profile[\s\S]*Change password[\s\S]*Delete account[\s\S]*Log out/,
  'account management is constructed with native SWF menu rows');
assert.doesNotMatch(webSettings, /BrowserBridge_Action\("(?:manageProfile|deleteAccount)"\)/,
  'native account actions do not open the outer browser dialogs');
assert.doesNotMatch(browserRows, /Browser Sync/, 'account saves replace the optional Browser Sync row');
const extrasRows = browserRows.slice(browserRows.indexOf('} else {', browserRows.indexOf('else if (page == PAGE_BROWSER)')));
assert.match(extrasRows, /row\("FPS Counter", &engineData, E::SYSTEM_FIELD_WEB_FPS_COUNTER/,
  'FPS Counter is owned by the existing system settings data source');
assert.match(extrasRows, /row\("Developer levels", &browserData, B::BROWSER_FIELD_DEVELOPER_LEVELS/,
  'Developer levels are owned by the browser preference data source');
assert.match(extrasRows, /row\("Enable console", &browserData, B::BROWSER_FIELD_ENABLE_CONSOLE/);
assert.match(handler, /nextScreen == SHELL_AREA_BROWSER_SETTINGS \|\| nextScreen == SHELL_AREA_EXTRAS/,
  'Extras uses the settings frame and suppresses the DOOM logo');
assert.doesNotMatch(system, /fullscreenKind/, 'native Display has no separate F11 mode or grey-out logic');
assert.doesNotMatch(browserRows.slice(browserRows.indexOf('else if (page == PAGE_BROWSER)'), browserRows.indexOf('} else {', browserRows.indexOf('else if (page == PAGE_BROWSER)'))),
  /Developer levels/, 'Developer levels no longer appear in Browser');
assert.doesNotMatch(system,
  /SetLabel\("FPS Counter"\)/, 'FPS Counter no longer appears in Display');
assert.match(screenHeader, /SYSTEM_FIELD_WEB_FPS_COUNTER = 900/,
  'the FPS data field is shared between Display and Extras screens');
assert.match(system, /case idMenuDataSource_SystemSettings::SYSTEM_FIELD_WEB_FPS_COUNTER:\s*web_showFPS\.SetBool\(!web_showFPS\.GetBool\(\)\);/,
  'FPS setting toggles the live web_showFPS cvar');
assert.match(webSettings, /command == E::SYSTEM_FIELD_WEB_FPS_COUNTER\) engineData\.AdjustField\(command, 1\)/,
  'FPS command bypasses Browser/Video/Audio field ranges and does not trigger restart logic');
assert.match(extractBlock(webSettings, 'bool idMenuScreen_Shell_WebSettings::HandleAction('),
  /typedef idMenuScreen_Shell_SystemOptions::idMenuDataSource_SystemSettings E;/,
  'the shared FPS field type is qualified in its action handler scope');
assert.match(webSettings, /\(page == PAGE_BROWSER \|\| page == PAGE_EXTRAS\) && browserData\.IsDataChanged\(\)\) BrowserSettingsConfirm\("restart"\)/,
  'developer-level changes retain the restart confirmation on Extras');

assert.match(multiplayer, /const bool canStart = host && players >= 2 && BrowserBridge_GetNumber\("mpStarted"\) == 0;\s*AddRow\(players < 2 \? "Waiting for another player" : "Start game", MP_CMD_START, !canStart\);/,
  'versus Start stays disabled with a waiting label until two players are present');
assert.match(multiplayer, /BrowserBridge_GetNumber\("mpInRoom"\) && BrowserBridge_GetNumber\("mpRoomPlayers"\) >= 2 &&\s*!BrowserBridge_GetNumber\("mpStarted"\)/,
  'native versus dispatch applies the same player-count guard');
assert.match(multiplayer, /if \(autoStartCoop && inRoom && coopSaveState == 2 && !BrowserBridge_GetNumber\("mpStarted"\)\)/,
  'co-op host automatically starts a prepared save once');
assert.match(multiplayer, /saveCount != lastSaveCount \|\| saveBusy != lastSaveBusy/,
  'save enumeration completion refreshes greyed co-op controls');
assert.match(extractBlock(multiplayer, 'void idMenuScreen_Shell_WebMultiplayer::RebuildPage()'), /AddRow\("Co-Op", MP_CMD_COOP\)/);
const campaign = source('engine/chocolate-doom3-bfg/neo/d3xp/menus/MenuScreen_Shell_Singleplayer.cpp');
assert.match(campaign, /BrowserBridge_GetNumber\("mpCoopCampaignPicker"\) && cvarSystem->GetCVarBool\("web_developerMenu"\)/,
  'developer launch is gated inside Create Game campaign choices');
assert.match(campaign, /option.Append\("Load Level"\)/);
assert.doesNotMatch(multiplayer, /AddRow\("Load Level/);
const redirect = extractBlock(handler, 'if ((nextState == SHELL_STATE_PARTY_LOBBY || nextState == SHELL_STATE_GAME_LOBBY || nextState == SHELL_STATE_CONNECTING)');
assert.match(redirect, /!BrowserBridge_GetNumber\("mpCoopSavePicker"\)/,
  'party-state routing leaves the native Load Game picker open');
assert.match(multiplayer, /SetHeading\(coopFlow \? "Create Game" : "Create Lobby"\)/);
const createPage = extractBlock(multiplayer, 'case PAGE_CREATE:');
const campaignPage = extractBlock(multiplayer, 'case PAGE_ROOM:');
assert.doesNotMatch(createPage, /"Continue Game"|"Load Game"/, 'save choices belong to the next screen');
assert.match(createPage, /coopFlow \? "Create Game" : "Create Lobby"/);
assert.match(campaignPage, /"Choose Campaign"[\s\S]*AddRow\("Continue Game", MP_CMD_CONTINUE[\s\S]*AddRow\("Load Game", MP_CMD_LOAD_SAVE/);
const roomBack = extractBlock(extractBlock(multiplayer, 'void idMenuScreen_Shell_WebMultiplayer::Back()'), 'if (page == PAGE_ROOM)');
assert.match(roomBack, /ShowLeaveLobbyConfirm\(\);/, 'leaving a lobby asks for confirmation first');
const leaveConfirm = extractBlock(multiplayer, 'void idMenuScreen_Shell_WebMultiplayer::ConfirmLeaveLobby()');
assert.match(leaveConfirm, /pendingCoopSaveCommand = 0;\s*pendingCampaign = false;\s*autoStartCoop = false;/, 'leaving cancels pending automatic starts');
assert.match(leaveConfirm, /SetNextScreen\(SHELL_AREA_ROOT/, 'confirmed leave returns to the main menu');
assert.match(multiplayer, /SetNextScreen\(coopDevChoice \? SHELL_AREA_DEV : SHELL_AREA_CAMPAIGN/,
  'co-op reuses the native campaign and developer screens');
assert.match(multiplayer, /SetOptionType\(OPTION_SLIDER_TEXT\)[\s\S]*SetDataSource\(this, command\)/,
  'create options use real native cycle controls');
assert.match(multiplayer, /SetHeading\(pageHeading\.c_str\(\)\)/, 'the heading is refreshed after authored entrance frames');
assert.match(multiplayer, /renderedPage == page[\s\S]*SetFocusIndex\(view - offset, true\)/,
  'same-page refreshes retain keyboard selection');
assert(createPage.indexOf('AddCycleRow("Mode"') < createPage.indexOf('AddCycleRow("Map"'));
const joinPage = extractBlock(multiplayer, 'case PAGE_JOIN:');
assert(joinPage.indexOf('AddRow("Refresh rooms"') < joinPage.indexOf('"Enter private code:'), 'Refresh precedes private code');

console.log('Native menu wrapping and Extras ownership checks passed.');
