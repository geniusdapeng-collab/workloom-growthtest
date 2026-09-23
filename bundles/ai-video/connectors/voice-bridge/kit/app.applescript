-- 小织声音工坊 · 主程序（安装脚本会用真实路径替换 __HELPER__ / __KIT__）
-- 三个动作：克隆我的声音 / 文字转语音 / 给视频配音；全程只有对话框，不需要打命令。
property helperPath : "__HELPER__"
property kitPath : "__KIT__"
-- 默认提词稿（念自己的话也行；念这段是为了覆盖常见音节，克隆更稳）
property practiceScript : "大家好，我是小织。今天为你播报三条经营要点：答案可见度上升百分之十八，获客成本下降百分之十二。"

on run
	set menuItems to {"① 克隆我的声音（录 12 秒）", "② 文字转语音（播报试听）", "③ 给视频配音", "④ 打开声音文件夹"}
	set picked to choose from list menuItems with title "小织声音工坊" with prompt "想做什么？" default items {item 1 of menuItems} OK button name "开始" cancel button name "先不用"
	if picked is false then return
	set choice to item 1 of picked

	if choice begins with "①" then
		set tip to "接下来录 12 秒左右。点『开始录音』后，下面这段文字会留在屏幕正中（会另开一个提词器窗口），照着念就行：" & return & return & practiceScript & return & return & "不用等提示音，看到文字就开始念，念完自然停下即可；多录的空白我会自动裁掉。不想念这段也可以，说一句「大家好，我是某某，很高兴认识你」就行。第一次使用 macOS 会问麦克风权限，请点『允许』。"
		display dialog tip buttons {"取消", "开始录音"} default button "开始录音" with title "小织声音工坊" with icon note
		-- 提词器与「正在生成音色」窗口由执行器自己弹（它知道录音何时开始/结束），这里不再叠进度框
		-- 用应用包内的原生录音器：麦克风权限才会归属到『小织声音工坊』（用 ffmpeg 会被系统静默拒绝）
		set recorderPath to (POSIX path of (path to me)) & "Contents/MacOS/vrec"
		set recorderArg to ""
		try
			do shell script "test -x " & quoted form of recorderPath
			set recorderArg to " --recorder " & quoted form of recorderPath
		end try
		my runTask("record --script " & quoted form of practiceScript & recorderArg, "", false)
	else if choice begins with "②" then
		set answer to display dialog "输入要播报的文字：" default answer "您好，我是小织，今天的经营日报已经准备好了。" buttons {"取消", "生成并试听"} default button "生成并试听" with title "小织声音工坊"
		my runTask("speak --text " & quoted form of (text returned of answer), "正在合成语音…（约 1–2 分钟）", true)
	else if choice begins with "③" then
		-- 注意：choose file 不支持 with title（只有 with prompt），写上会编译报 "Expected given/with/without…"
		set videoFile to choose file with prompt "选一个视频（mp4 / mov）"
		set answer to display dialog "输入配音文案（会按句子分配时长；句子越短越容易对上画面）：" default answer "您好，我是小织。今天为您播报三条经营要点。" buttons {"取消", "开始配音"} default button "开始配音" with title "小织声音工坊"
		my runTask("dub --video " & quoted form of (POSIX path of videoFile) & " --text " & quoted form of (text returned of answer), "正在配音…（约 2–6 分钟）", true)
	else
		do shell script "open " & quoted form of (POSIX path of (path to home folder) & ".workloom/voice-station")
	end if
end run

on runTask(argString, progressText, showProgress)
	set resultFile to "/tmp/voice-gui-result.json"
	do shell script "rm -f " & quoted form of resultFile
	if showProgress then
		do shell script "nohup osascript " & quoted form of (kitPath & "/progress-dialog.applescript") & " " & quoted form of progressText & " >/dev/null 2>&1 & echo $! > /tmp/voice-gui-progress.pid"
	end if
	try
		do shell script "/bin/bash " & quoted form of helperPath & " " & argString & " --result " & quoted form of resultFile
	on error
		-- 失败原因由 helper 写进结果文件；这里不弹系统级报错，避免吓到用户
	end try
	if showProgress then do shell script "kill $(cat /tmp/voice-gui-progress.pid) 2>/dev/null; rm -f /tmp/voice-gui-progress.pid; true"
	-- 麦克风没授权时给一个直达设置的按钮，别让用户自己去翻系统设置
	set needsPermission to false
	try
		set statusLine to do shell script "/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get(\"status\",\"\"))' " & quoted form of resultFile
		if statusLine is "permission" then set needsPermission to true
	end try
	set theSummary to do shell script "/bin/bash " & quoted form of helperPath & " --summary " & quoted form of resultFile
	if needsPermission then
		set answer to display dialog theSummary buttons {"稍后再说", "打开麦克风设置"} default button "打开麦克风设置" with title "小织声音工坊" with icon caution
		if button returned of answer is "打开麦克风设置" then
			do shell script "open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'"
		end if
	else
		display dialog theSummary buttons {"好"} default button "好" with title "小织声音工坊" with icon note
	end if
end runTask
