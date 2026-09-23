#!/usr/bin/env bash
# 一键安装「小织声音工坊」应用（macOS，双击即用，不需要打命令）
#
#   bash kit/install-apps.sh [--dest "$HOME/Applications"] [--no-desktop]
#
# 做三件事：把 app.applescript 里的路径替换成真实路径 → osacompile 编译成 .app →
# 补 Info.plist（名称 + 麦克风用途说明）→ 安装到 ~/Applications（默认再在桌面放一个快捷方式）。
# 幂等：重复执行=覆盖安装。卸载：删掉 ~/Applications/小织声音工坊.app 即可（声音档案仍在 ~/.workloom）。
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Applications"
DESKTOP_LINK=1
APP_NAME="小织声音工坊"

while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST="${2:?--dest 需要目录}"; shift 2 ;;
    --no-desktop) DESKTOP_LINK=0; shift ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

command -v osacompile >/dev/null 2>&1 || { echo "✗ 找不到 osacompile（需要 macOS 命令行工具：xcode-select --install）" >&2; exit 2; }
[ -x "/usr/libexec/PlistBuddy" ] || { echo "✗ 找不到 PlistBuddy（系统异常）" >&2; exit 2; }

TMP_SRC="$(mktemp -t voice-workshop).applescript"
trap 'rm -f "$TMP_SRC"' EXIT
sed -e "s|__HELPER__|$HERE/gui-voice.sh|g" -e "s|__KIT__|$HERE|g" "$HERE/app.applescript" > "$TMP_SRC"

mkdir -p "$DEST"
APP="$DEST/$APP_NAME.app"
rm -rf "$APP"
osacompile -o "$APP" "$TMP_SRC"

PLIST="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName $APP_NAME" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :CFBundleName string $APP_NAME" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $APP_NAME" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string $APP_NAME" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier cool.workloom.voice-workshop" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string cool.workloom.voice-workshop" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :NSMicrophoneUsageDescription string 需要用你的麦克风录一段参考音频，用来克隆你自己的声音（音频只保存在本机）。" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Set :NSMicrophoneUsageDescription 需要用你的麦克风录一段参考音频，用来克隆你自己的声音（音频只保存在本机）。" "$PLIST"

chmod +x "$HERE/gui-voice.sh" "$HERE/station.sh" "$HERE/selftest.sh" 2>/dev/null || true
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

if [ "$DESKTOP_LINK" = "1" ]; then
  ln -sfn "$APP" "$HOME/Desktop/$APP_NAME" 2>/dev/null || true
fi

echo "✓ 已安装：$APP"
[ "$DESKTOP_LINK" = "1" ] && echo "✓ 桌面快捷方式：$HOME/Desktop/$APP_NAME"
echo
echo "用法：双击『${APP_NAME}』→ 选『① 克隆我的声音』→ 按提示念 12 秒 → 自动建档并试听。"
echo "自检（可选）：bash $HERE/gui-voice.sh doctor"
