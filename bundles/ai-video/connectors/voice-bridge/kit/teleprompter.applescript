-- 小织声音工坊 · 提词器（录音期间常驻，录完由执行器关闭）
-- 用法：osascript teleprompter.applescript "<要念的文字>" <自动关闭秒数>
--
-- 为什么单独一个进程：用户反馈"点了开始录音后，要说的内容消失了"——
-- 提词稿必须比确认框活得久：确认框一关，这段文字仍要留在屏幕正中，直到录完。
on run argv
	set theScript to "（没有拿到提词稿，随便说一句也行）"
	if (count of argv) > 0 then set theScript to item 1 of argv
	set autoClose to 30
	if (count of argv) > 1 then
		try
			set autoClose to (item 2 of argv) as integer
		end try
	end if
	set message to "【正在录音】请直接照着念下面这段（不用等，念完自然停下就行）：" & return & return & theScript & return & return & "念完不用管这个框，我会自动收尾。"
	try
		display dialog message buttons {"照着念"} default button "照着念" with title "小织声音工坊 · 提词器" with icon note giving up after autoClose
	on error
		-- 用户点了按钮或自动超时都算正常收尾
	end try
end run
