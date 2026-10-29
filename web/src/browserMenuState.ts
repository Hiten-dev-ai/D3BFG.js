// Native menu reads must never synchronously wait on the browser/network thread.
// A seqlock snapshot is published by the DOM thread; workers keep the previous
// complete snapshot if a publication happens concurrently.
export const MENU_STATE_WORDS = 12 + 65536 / 4;
const numberKeys = ('accountBusy aspect audioOutput audioOutputCount audioOutputSupported audioSplitSupported browserSync cacheMode developerMenu enableConsole frameRateCap frameRateCount fullscreen mpCanReconnect mpCoopCampaignPicker mpCoopConnecting mpCoopDevPicker mpCoopSavePicker mpErrorCode mpHostLoading mpHostPeerId mpInRoom mpIsHost mpLobbyCount mpPeerId mpPrivate mpRevision mpRoomKind mpRoomLives mpRoomMax mpRoomPlayers mpScanning mpStarted mpStatus nativeNoticeCount offline persistSaves resolutionCount resolutionIndex skipIntro startupFrameRateCap').split(' ');
const textKeys = ('accountStatus aspectName audioOutputName connectionStatus mpError mpErrorMessage mpPrivateCode mpReconnectName mpRoomId mpRoomKind mpRoomMap mpRoomMode mpRoomName nativeNoticeText profileEmail profileName rendererName resolutionName statusMessage storageSummary').split(' ');
let previous = '';
export function publishBrowserMenuState(shared: Int32Array, bridge: {
  getNumber(key: string): number; getText(key: string): string;
}): void {
  const numbers: Record<string, number> = {}, texts: Record<string, string> = {};
  for (const key of numberKeys) numbers[key] = Number(bridge.getNumber(key)) || 0;
  for (let i = 0; i < 10; ++i) numbers[`frameRateValue${i}`] = bridge.getNumber(`frameRateValue${i}`);
  for (const key of textKeys) texts[key] = bridge.getText(key);
  for (let i = 0; i < Math.min(128, numbers.mpLobbyCount); ++i) {
    for (const field of ['Name', 'Id', 'Occupancy']) {
      const key = `mpLobby${field}${i}`; texts[key] = bridge.getText(key);
    }
  }
  for (let i = 0; i < 8; ++i) texts[`mpRoster${i}`] = bridge.getText(`mpRoster${i}`);
  const json = JSON.stringify({ numbers, texts });
  if (json === previous && Atomics.load(shared, 9) !== 0) return;
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > 65536 || shared.length < MENU_STATE_WORDS) return;
  Atomics.add(shared, 9, 1);
  new Uint8Array(shared.buffer, shared.byteOffset + 48, bytes.length).set(bytes);
  Atomics.store(shared, 10, bytes.length);
  Atomics.add(shared, 9, 1);
  previous = json;
}
