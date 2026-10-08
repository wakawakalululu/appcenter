/**
 * 长驻宿主（桌面壳/托盘）的最后防线。
 *
 * 本机 Node 24 实测语义：未处理的 Promise 拒绝与未捕获异常都会直接终止宿主进程（exit 1），
 * 于是托盘「静默消失」而日志里什么都没有。这里不假装能从坏状态里恢复，只做两件事：
 * 1. 保证栈被写出来（有 sink 就交给 sink，没有就 stderr），死也要留下死因；
 * 2. 区分两种情况——`uncaughtException` 记录后仍按原样退出（继续跑等于在不确定状态里干活），
 *    `unhandledRejection` 记录后不退出：本仓库剩下的这类站点都是旁路任务（装后回读、
 *    清单清理、事件广播），它们失败的代价不该是整个宿主。
 */
export interface GuardrailHooks {
  log?(level: "error", message: string): void;
  onFatal?(error: Error): void;
}

interface State {
  rejections: number;
  exceptions: number;
}

const state: State = { rejections: 0, exceptions: 0 };
let teardown: (() => void) | null = null;

function describe(reason: unknown): string {
  if (reason instanceof Error) return reason.stack ?? reason.message;
  return String(reason);
}

/** 安装护栏；重复调用只保留一份监听器，返回卸载函数。 */
export function installProcessGuardrails(hooks: GuardrailHooks = {}): () => void {
  teardown?.();
  const write = (message: string): void => {
    if (hooks.log) hooks.log("error", message);
    else console.error(message);
  };
  const onRejection = (reason: unknown): void => {
    state.rejections += 1;
    write("unhandledRejection #" + String(state.rejections) + ": " + describe(reason));
  };
  const onException = (error: unknown): void => {
    state.exceptions += 1;
    write("uncaughtException #" + String(state.exceptions) + ": " + describe(error));
    hooks.onFatal?.(error instanceof Error ? error : new Error(describe(error)));
    // 不调 process.exit 的话 Node 自己也会以 1 结束；显式退出只是为了让 sink 里的死因是最后一条记录。
    process.exit(1);
  };
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);
  teardown = () => {
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
    teardown = null;
  };
  return teardown;
}

/** 给测试与自检用：护栏拦下了多少次（也写进每条日志的序号里）。 */
export function guardrailCounts(): State {
  return { ...state };
}
