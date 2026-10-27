/* 回放缓冲被裁剪后，头部可能停在转义序列中间；跳到第一个完整序列的结束处，
   保证回放从解析器顶层状态开始（否则 xterm 会把后续文本当序列载荷吞掉，显示不完整） */
export function syncReplayHead(s) {
	const esc = s.indexOf("\x1b");
	if (esc < 0) return s; /* 纯文本，本来就安全 */
	const c = s[esc + 1];
	if (c === "[") { /* CSI：扫描到终结符 @~ */
		let i = esc + 2;
		while (i < s.length && !(s[i] >= "@" && s[i] <= "~")) i++;
		return i < s.length ? s.slice(i + 1) : s; /* 未闭合：退回原样 */
	}
	if (c === "]") { /* OSC：扫描到 BEL 或 ST */
		let i = esc + 2;
		while (i < s.length) {
			if (s[i] === "\x07") return s.slice(i + 1);
			if (s[i] === "\x1b" && s[i + 1] === "\\") return s.slice(i + 2);
			i++;
		}
		return s;
	}
	/* 其他 ESC 序列按两字符处理 */
	return s.slice(esc + 2);
}
