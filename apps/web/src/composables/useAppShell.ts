/**
 * Shell chrome: tab, mid title, header menus, conversation-list swipe / context menu.
 * D-02 P0 extract from App.vue — behavior unchanged; App keeps profile/contacts/moments.
 */
import { computed, ref, type Ref } from 'vue';
import type { Conversation } from '../api/client';

export type Tab = 'chat' | 'contacts' | 'moments';

export function useAppShell(opts: {
  creatingGroup: Ref<boolean>;
  /** Return true if a profile overlay is open (mirrors prior if-profileView guard). */
  hasProfile: () => boolean;
  closeProfile: () => void | Promise<void>;
  openConversation: (id: string) => void | Promise<void>;
  deleteConversationById: (id: string, title: string) => Promise<boolean>;
  findConversation: (id: string) => Conversation | undefined;
}) {
  const tab = ref<Tab>('chat');
  const menuOpen = ref(false);
  const listCtxId = ref<string | null>(null);
  const listCtxPos = ref({ x: 0, y: 0 });
  const swipeId = ref<string | null>(null);
  const swipeX = ref(0);
  let swipeStartX = 0;
  let swipeActiveId: string | null = null;
  let swipeMoved = false;

  const midTitle = computed(() => {
    if (tab.value === 'chat') return '消息';
    if (tab.value === 'contacts') return opts.creatingGroup.value ? '创建群聊' : '通讯录';
    return '空间';
  });

  async function switchTab(next: Tab) {
    if (opts.hasProfile()) await opts.closeProfile();
    tab.value = next;
  }

  function onListContextMenu(e: MouseEvent, c: Conversation) {
    e.preventDefault();
    listCtxId.value = c.id;
    listCtxPos.value = { x: e.clientX, y: e.clientY };
    swipeId.value = null;
    swipeX.value = 0;
  }

  async function onListCtxDelete() {
    const c = opts.findConversation(listCtxId.value || '');
    if (!c) {
      listCtxId.value = null;
      return;
    }
    await deleteFromList(c);
  }

  async function deleteFromList(c: Conversation) {
    listCtxId.value = null;
    swipeId.value = null;
    swipeX.value = 0;
    await opts.deleteConversationById(c.id, c.title);
  }

  function onSwipeStart(e: PointerEvent, id: string) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    swipeActiveId = id;
    swipeStartX = e.clientX;
    swipeMoved = false;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  function onSwipeMove(e: PointerEvent) {
    if (!swipeActiveId) return;
    const dx = e.clientX - swipeStartX;
    if (Math.abs(dx) > 6) swipeMoved = true;
    if (dx < 0) {
      swipeId.value = swipeActiveId;
      swipeX.value = Math.max(dx, -72);
    } else if (swipeId.value === swipeActiveId) {
      swipeX.value = Math.min(0, dx);
    }
  }

  function onSwipeEnd() {
    if (!swipeActiveId) return;
    if (swipeId.value === swipeActiveId && swipeX.value < -36) {
      swipeX.value = -72;
    } else {
      swipeId.value = null;
      swipeX.value = 0;
    }
    swipeActiveId = null;
  }

  function swipeStyle(id: string) {
    if (swipeId.value !== id) return undefined;
    return { transform: `translateX(${swipeX.value}px)` };
  }

  function onListItemClick(c: Conversation) {
    if (swipeMoved) {
      swipeMoved = false;
      return;
    }
    if (swipeId.value && swipeId.value !== c.id) {
      swipeId.value = null;
      swipeX.value = 0;
    }
    listCtxId.value = null;
    void opts.openConversation(c.id);
  }

  return {
    tab,
    menuOpen,
    listCtxId,
    listCtxPos,
    swipeId,
    swipeX,
    midTitle,
    switchTab,
    onListContextMenu,
    onListCtxDelete,
    deleteFromList,
    onSwipeStart,
    onSwipeMove,
    onSwipeEnd,
    swipeStyle,
    onListItemClick,
  };
}
