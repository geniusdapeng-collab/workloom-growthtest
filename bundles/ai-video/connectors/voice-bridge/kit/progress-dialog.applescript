-- 小织声音工坊 · 进度提示对话框（独立进程，任务结束后被主程序 kill）
-- 用法：osascript progress-dialog.applescript "正在录音…"
on run argv
	set message to "正在处理，请稍候…"
	if (count of argv) > 0 then set message to item 1 of argv
	display dialog message buttons {"后台运行"} default button "后台运行" with title "小织声音工坊" with icon note
end run
