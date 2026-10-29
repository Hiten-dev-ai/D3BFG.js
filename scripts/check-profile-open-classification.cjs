const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const sourcePath = path.join(repoRoot, 'engine/chocolate-doom3-bfg/neo/sys/common/savegame.cpp');
const source = fs.readFileSync(sourcePath, 'utf8');
const helperMatch = source.match(/static saveGameError_t ClassifyBrowserProfileOpenFailure\([\s\S]*?\n\}/);
if (!helperMatch) {
  throw new Error(`Could not find the production profile-open classifier in ${sourcePath}`);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doom3-profile-open-'));
const harnessPath = path.join(tempRoot, 'profile_open_harness.cpp');
const executablePath = path.join(tempRoot, process.platform === 'win32' ? 'profile_open_harness.exe' : 'profile_open_harness');
const harness = `
#include <cerrno>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <sys/stat.h>
#include <vector>

enum saveGameError_t { SAVEGAME_E_NONE, SAVEGAME_E_FILE_NOT_FOUND, SAVEGAME_E_CORRUPTED };
${helperMatch[0]}

static saveGameError_t ClassifyPath(const std::filesystem::path& path) {
    struct stat info;
    errno = 0;
    const int result = stat(path.string().c_str(), &info);
    const int error = errno;
    return ClassifyBrowserProfileOpenFailure(result, error);
}

static void Require(bool condition, const char* message) {
    if (!condition) {
        std::cerr << "FAIL: " << message << '\\n';
        std::exit(1);
    }
}

static void Persist(const std::filesystem::path& path, const std::vector<unsigned char>& bytes) {
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    Require(static_cast<bool>(output), "open persisted profile for write");
    output.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    Require(static_cast<bool>(output), "write persisted profile bytes");
}

static std::vector<unsigned char> Restore(const std::filesystem::path& path) {
    std::ifstream input(path, std::ios::binary);
    Require(static_cast<bool>(input), "open persisted profile for restore");
    return std::vector<unsigned char>(std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>());
}

int main(int argc, char** argv) {
    Require(argc == 2, "temporary root argument");
    const std::filesystem::path root(argv[1]);
    const auto missing = root / "missing.bin";
    const auto valid = root / "valid.bin";
    const auto corrupt = root / "corrupt.bin";
    const auto truncated = root / "truncated.bin";

    Require(ClassifyPath(missing) == SAVEGAME_E_FILE_NOT_FOUND, "absent first-run profile is file-not-found");

    const std::vector<unsigned char> validBytes = { 0x44, 0x33, 0x42, 0x46, 0x01, 0x10, 0x20, 0x30 };
    Persist(valid, validBytes);
    Require(Restore(valid) == validBytes, "valid persisted profile bytes survive a write/read roundtrip");
    Require(ClassifyPath(valid) == SAVEGAME_E_CORRUPTED, "existing profile is not reclassified as missing when open fails");

    auto corruptBytes = validBytes;
    corruptBytes.back() ^= 0xff;
    Persist(corrupt, corruptBytes);
    Require(Restore(corrupt) == corruptBytes && corruptBytes != validBytes, "corrupt persisted profile fixture remains distinguishable");
    Require(ClassifyPath(corrupt) == SAVEGAME_E_CORRUPTED, "corrupt existing profile remains an error");

    const std::vector<unsigned char> truncatedBytes = { 0x44, 0x33 };
    Persist(truncated, truncatedBytes);
    Require(Restore(truncated) == truncatedBytes, "truncated persisted profile fixture is readable as stored");
    Require(ClassifyPath(truncated) == SAVEGAME_E_CORRUPTED, "truncated existing profile remains an error");

    Require(ClassifyBrowserProfileOpenFailure(-1, EACCES) == SAVEGAME_E_CORRUPTED,
        "permission-denied stat failure remains an error");
    auto permissionsError = std::error_code();
    std::filesystem::permissions(valid, std::filesystem::perms::none, permissionsError);
    if (!permissionsError) {
        std::ifstream denied(valid, std::ios::binary);
        if (!denied) {
            Require(ClassifyPath(valid) == SAVEGAME_E_CORRUPTED, "unreadable existing profile remains an error");
            std::cout << "PASS: permission-denied file open is classified as corrupted\\n";
        } else {
            std::cout << "SKIP: filesystem did not enforce the temporary file permission change\\n";
        }
        std::filesystem::permissions(valid,
            std::filesystem::perms::owner_read | std::filesystem::perms::owner_write |
            std::filesystem::perms::group_read | std::filesystem::perms::others_read,
            permissionsError);
    } else {
        std::cout << "SKIP: temporary file permissions are not changeable on this platform\\n";
    }

    std::cout << "PASS: missing, persisted, corrupt, and truncated profile cases\\n";
    return 0;
}
`;

fs.writeFileSync(harnessPath, harness);
const compiler = process.env.CXX || 'clang++';
try {
  const compile = spawnSync(compiler, ['-std=c++17', harnessPath, '-o', executablePath], { encoding: 'utf8' });
  if (compile.error) throw compile.error;
  if (compile.status !== 0) {
    throw new Error(`Native harness compilation failed with ${compiler}:\n${compile.stdout}${compile.stderr}`);
  }
  const run = spawnSync(executablePath, [tempRoot], { encoding: 'utf8' });
  if (run.error) throw run.error;
  process.stdout.write(run.stdout || '');
  if (run.status !== 0) {
    throw new Error(`Native profile-open harness failed:\n${run.stdout}${run.stderr}`);
  }
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
