import { setPortBroadcaster, reportError, reportWarning, getReporterStats } from '../lib/error-reporter.js';

const out = document.getElementById('out');
const log = document.getElementById('log');
const runBtn = document.getElementById('runBtn');

function append(msg) { log.textContent += msg + '\n'; }

// 安装广播接收器：把 payload 显示到页面上
setPortBroadcaster((payload) => {
  append('[BROADCAST RECEIVED] ' + JSON.stringify(payload, null, 2));
  out.innerText = '最近广播：' + (payload?.message || JSON.stringify(payload));
});

runBtn.addEventListener('click', async () => {
  append('触发 reportError...');
  try {
    await reportError('test:manual', new Error('这是一个测试错误'), { fatal: false });
    append('reportError 返回，等待 IndexedDB 写入与广播...');
    const stats = getReporterStats();
    append('Reporter stats: ' + JSON.stringify(stats));
  } catch (e) {
    append('reportError 抛出异常: ' + String(e));
  }
});

append('测试脚本就绪。点击按钮触发。');
