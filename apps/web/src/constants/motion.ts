/** UI-1 motion foundation — duration / easing tokens.
 *
 * Scene map (基础层约定；UI-2/UI-3 再挂消息入场、红点等):
 * - micro（hover / active / 按压反馈）→ durationFast + easingStandard
 * - panel（侧栏 tab 内容感、轻量状态切换）→ durationNormal + easingStandard
 * - overlay（确认框 / 人设编辑等 mask 显隐）→ durationNormal + easingEnter/Exit
 * - emphasis（强调态，少用）→ durationSlow + easingEmphasized
 * - ambient（封面/氛围缓变，装饰向）→ durationAmbient*
 *
 * CSS 镜像：`styles/wechat.css` `:root` 中的 `--motion-*`。
 * 新交互优先用 CSS 变量；JS 需要读数值时用本文件常量。
 */
export const MOTION_DURATION_MS = {
  instant: 0,
  fast: 120,
  normal: 200,
  slow: 320,
  ambient: 1500,
  ambientSlow: 3500,
} as const;

export const MOTION_EASING = {
  /** 通用 UI 反馈 */
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
  /** 进入（overlay / fade-in） */
  enter: 'cubic-bezier(0, 0, 0.2, 1)',
  /** 离开（overlay / fade-out） */
  exit: 'cubic-bezier(0.4, 0, 1, 1)',
  /** 强调 */
  emphasized: 'cubic-bezier(0.2, 0, 0, 1)',
} as const;

export type MotionScene = 'micro' | 'panel' | 'overlay' | 'emphasis' | 'ambient';

export const MOTION_SCENE: Record<
  MotionScene,
  { durationMs: number; easing: string; note: string }
> = {
  micro: {
    durationMs: MOTION_DURATION_MS.fast,
    easing: MOTION_EASING.standard,
    note: 'nav / 列表 hover、按钮按压',
  },
  panel: {
    durationMs: MOTION_DURATION_MS.normal,
    easing: MOTION_EASING.standard,
    note: '侧栏 tab / 轻量面板状态',
  },
  overlay: {
    durationMs: MOTION_DURATION_MS.normal,
    easing: MOTION_EASING.enter,
    note: 'confirm mask / 人设编辑弹层',
  },
  emphasis: {
    durationMs: MOTION_DURATION_MS.slow,
    easing: MOTION_EASING.emphasized,
    note: '少用：强调反馈',
  },
  ambient: {
    durationMs: MOTION_DURATION_MS.ambient,
    easing: MOTION_EASING.standard,
    note: '封面/氛围装饰缓变',
  },
};
