import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Paperclip, RefreshCw, Send } from 'lucide-react';
import { ApiError } from '@/api/client';
import { chatApi } from '@/collaboration/api';
import type {
  ChatConversationRecord,
  ChatMessageRecord,
} from '@/collaboration/types';
import { ResourceState, type ResourcePhase } from '@/components/ResourceState';
import type { Locale, Messages } from '@/i18n';
import { canViewChat } from '@/permissions';
import { createLatestRequestGuard } from './latestRequestGuard';

const panel =
  'rounded-3xl border border-slate-200 bg-white shadow-panel dark:border-white/10 dark:bg-white/5';
const ghostButton =
  'inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-extrabold text-slate-700 transition hover:border-brand-300 hover:text-brand-700 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-slate-200';
const primaryButton =
  'inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-extrabold text-white transition hover:bg-brand-700 disabled:opacity-50';

function typeLabel(messages: Messages, type: ChatConversationRecord['type']): string {
  if (type === 'department') return messages.chatDepartment;
  if (type === 'announcement') return messages.chatAnnouncement;
  return messages.chatDirect;
}

export function ChatPage({
  locale,
  messages,
  permissions,
  focusResourceId = null,
}: {
  locale: Locale;
  messages: Messages;
  permissions: readonly string[];
  /** Conversation a notification deep link asked this screen to open. */
  focusResourceId?: string | null;
}) {
  const canView = canViewChat(permissions);

  const [phase, setPhase] = useState<ResourcePhase>(canView ? 'loading' : 'forbidden');
  const [conversations, setConversations] = useState<ChatConversationRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messageList, setMessageList] = useState<ChatMessageRecord[]>([]);
  const [messagePhase, setMessagePhase] = useState<ResourcePhase>('empty');
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const guard = useRef(createLatestRequestGuard());
  const messageGuard = useRef(createLatestRequestGuard());

  const loadConversations = useCallback(async () => {
    if (!canView) {
      setPhase('forbidden');
      return;
    }
    const requestId = guard.current.begin();
    setPhase('loading');
    setActionError(null);
    try {
      const page = await chatApi.listConversations({ limit: 50 });
      if (!guard.current.isCurrent(requestId)) return;
      setConversations(page.items);
      setPhase(page.items.length === 0 ? 'empty' : 'ready');
    } catch (error) {
      if (!guard.current.isCurrent(requestId)) return;
      setPhase(error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error');
    }
  }, [canView]);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  const loadMessages = useCallback(async (conversationId: string) => {
    const requestId = messageGuard.current.begin();
    setMessagePhase('loading');
    try {
      const page = await chatApi.listMessages(conversationId, { limit: 40 });
      if (!messageGuard.current.isCurrent(requestId)) return;
      setMessageList(page.items);
      setOlderCursor(page.nextCursor);
      setMessagePhase(page.items.length === 0 ? 'empty' : 'ready');
      // Clearing unread is a side effect of actually opening the thread.
      await chatApi.markRead(conversationId);
      setConversations((current) =>
        current.map((row) => (row.id === conversationId ? { ...row, unreadCount: 0 } : row)),
      );
    } catch (error) {
      if (!messageGuard.current.isCurrent(requestId)) return;
      setMessagePhase(error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error');
    }
  }, []);

  useEffect(() => {
    if (!selectedId) {
      messageGuard.current.invalidate();
      setMessageList([]);
      setOlderCursor(null);
      setMessagePhase('empty');
      return;
    }
    void loadMessages(selectedId);
  }, [loadMessages, selectedId]);

  /** Only opens a conversation the membership-filtered list actually contains. */
  useEffect(() => {
    if (!focusResourceId) return;
    if (conversations.some((conversation) => conversation.id === focusResourceId)) {
      setSelectedId(focusResourceId);
    }
  }, [conversations, focusResourceId]);

  const selected = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedId) ?? null,
    [conversations, selectedId],
  );

  /**
   * Refresh must reload the OPEN thread as well as the list.
   *
   * The delivery model here is deliberately poll-on-user-action (see decision
   * 2.5): there is no socket and no timer. If Refresh only reloaded the
   * conversation list, a message that arrived while a thread was open would
   * stay invisible no matter how many times the user pressed it — which would
   * make the documented model not actually work.
   */
  const refreshAll = useCallback(async () => {
    await loadConversations();
    if (selectedId) await loadMessages(selectedId);
  }, [loadConversations, loadMessages, selectedId]);

  /**
   * Keyset "load older": the backend returns each page already chronological,
   * so an older page is PREPENDED rather than merged and re-sorted. That keeps
   * ordering stable even when two messages share a timestamp — the cursor is
   * (createdAt, id), not createdAt alone.
   */
  const loadOlder = async () => {
    if (!selected || !olderCursor || busy) return;
    setBusy(true);
    try {
      const page = await chatApi.listMessages(selected.id, {
        before: olderCursor,
        limit: 40,
      });
      setMessageList((current) => [...page.items, ...current]);
      setOlderCursor(page.nextCursor);
    } catch {
      setActionError(messages.chatMessagesError);
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!selected || !draft.trim() || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const created = await chatApi.sendMessage(selected.id, { body: draft.trim() });
      setMessageList((current) => [...current, created]);
      setDraft('');
    } catch (error) {
      setActionError(
        error instanceof ApiError && error.status === 429
          ? messages.chatMessagesError
          : error instanceof ApiError && error.status === 403
            ? messages.chatRepliesDisabled
            : messages.chatMessagesError,
      );
    } finally {
      setBusy(false);
    }
  };

  const stampFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', {
        dateStyle: 'short',
        timeStyle: 'short',
      }),
    [locale],
  );

  const conversationList = (
    <ul className="divide-y divide-slate-100 dark:divide-white/10">
      {conversations.map((conversation) => (
        <li key={conversation.id}>
          <button
            type="button"
            onClick={() => setSelectedId(conversation.id)}
            className={`flex w-full flex-col gap-1 px-5 py-4 text-start transition hover:bg-slate-50 dark:hover:bg-white/5 ${
              selectedId === conversation.id ? 'bg-brand-50 dark:bg-brand-500/10' : ''
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-extrabold text-slate-950 dark:text-white">
                {conversation.title}
              </span>
              {conversation.unreadCount > 0 ? (
                <span className="shrink-0 rounded-lg bg-brand-600 px-2 py-0.5 text-xs font-extrabold text-white">
                  {conversation.unreadCount}
                </span>
              ) : null}
            </div>
            <span className="text-xs font-bold text-slate-400">
              {typeLabel(messages, conversation.type)}
            </span>
            {conversation.lastMessagePreview ? (
              <span className="truncate text-xs text-slate-500 dark:text-slate-400">
                {conversation.lastMessagePreview}
              </span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );

  const thread = selected ? (
    <div className="flex h-full min-h-[28rem] flex-col">
      <div className="flex items-center gap-3 border-b border-slate-200/80 px-5 py-4 dark:border-white/10">
        <button
          type="button"
          onClick={() => setSelectedId(null)}
          className="grid h-9 w-9 place-items-center rounded-xl border border-slate-200 dark:border-white/10 lg:hidden"
          aria-label={messages.cancel}
        >
          <ArrowLeft className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
        </button>
        <div className="min-w-0">
          <div className="truncate font-extrabold text-slate-950 dark:text-white">
            {selected.title}
          </div>
          <div className="text-xs font-bold text-slate-400">
            {typeLabel(messages, selected.type)}
          </div>
        </div>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
        {olderCursor ? (
          <button
            type="button"
            onClick={() => void loadOlder()}
            disabled={busy}
            className={`${ghostButton} mx-auto`}
          >
            {messages.loadOlder}
          </button>
        ) : null}

        {messagePhase !== 'ready' ? (
          <ResourceState
            phase={messagePhase}
            messages={messages}
            emptyMessage={messages.chatMessagesEmpty}
            errorMessage={messages.chatMessagesError}
            forbiddenMessage={messages.chatForbidden}
            onRetry={() => void loadMessages(selected.id)}
          />
        ) : (
          messageList.map((message) => (
            <div
              key={message.id}
              className={`flex ${message.isOwn ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-3 ${
                  message.isOwn
                    ? 'bg-brand-600 text-white'
                    : 'bg-slate-100 text-slate-900 dark:bg-white/10 dark:text-white'
                }`}
              >
                {!message.isOwn ? (
                  <div className="text-xs font-extrabold opacity-80">
                    {message.sender.displayName}
                  </div>
                ) : null}
                <p className="mt-1 whitespace-pre-line text-sm">{message.body}</p>
                {message.attachments.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {message.attachments.map((attachment) => (
                      <span
                        key={attachment.id}
                        className="inline-flex items-center gap-1 rounded-lg bg-black/10 px-2 py-1 text-xs font-bold"
                      >
                        <Paperclip className="h-3 w-3" aria-hidden="true" />
                        {attachment.originalFilename}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="mt-1 text-[0.7rem] font-bold opacity-70" dir="ltr">
                  {message.createdAt ? stampFormatter.format(new Date(message.createdAt)) : ''}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="border-t border-slate-200/80 px-5 py-4 dark:border-white/10">
        {selected.type === 'announcement' && !selected.repliesEnabled ? (
          <p className="text-sm font-bold text-slate-500">{messages.chatRepliesDisabled}</p>
        ) : (
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={messages.messagePlaceholder}
              rows={2}
              className="flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold dark:border-white/10 dark:bg-white/5"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={busy || !draft.trim()}
              className={primaryButton}
            >
              <Send className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
              {messages.sendMessage}
            </button>
          </div>
        )}
        <p className="mt-2 text-xs font-bold text-slate-400">{messages.chatRefreshHint}</p>
      </div>
    </div>
  ) : (
    <div className="grid h-full min-h-[28rem] place-items-center p-8 text-sm font-bold text-slate-500">
      {messages.chatSelectConversation}
    </div>
  );

  return (
    <div className="mx-auto max-w-7xl">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-950 dark:text-white sm:text-3xl">
            {messages.chatTitle}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-500 dark:text-slate-400">
            {messages.chatSubtitle}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refreshAll()}
          disabled={phase === 'loading' || !canView}
          className={ghostButton}
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          {messages.refresh}
        </button>
      </div>

      {actionError ? (
        <p role="alert" className="mt-4 text-sm font-bold text-red-600 dark:text-red-300">
          {actionError}
        </p>
      ) : null}

      {phase !== 'ready' ? (
        <ResourceState
          phase={phase}
          messages={messages}
          emptyMessage={messages.chatEmpty}
          errorMessage={messages.chatError}
          forbiddenMessage={messages.chatForbidden}
          onRetry={() => void loadConversations()}
        />
      ) : (
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          {/* Mobile shows one pane at a time; desktop shows both. */}
          <div className={`${panel} overflow-hidden ${selectedId ? 'hidden lg:block' : ''}`}>
            {conversationList}
          </div>
          <div className={`${panel} overflow-hidden ${selectedId ? '' : 'hidden lg:block'}`}>
            {thread}
          </div>
        </div>
      )}
    </div>
  );
}
