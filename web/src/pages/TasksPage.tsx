import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare, Pencil, Plus, RefreshCw } from 'lucide-react';
import { ApiError } from '@/api/client';
import { tasksApi } from '@/collaboration/api';
import type {
  TaskAssignmentRecord,
  TaskCommentRecord,
  TaskEligibleEmployee,
  TaskPriority,
  TaskRecord,
  TaskScope,
} from '@/collaboration/types';
import { ResourceState, type ResourcePhase } from '@/components/ResourceState';
import type { Locale, Messages } from '@/i18n';
import {
  canCommentOnTasks,
  canCreateTasks,
  canEditTasks,
  canProgressOwnTasks,
  canReviewTasks,
  canViewTasks,
} from '@/permissions';
import { createLatestRequestGuard } from './latestRequestGuard';

const panel =
  'rounded-3xl border border-slate-200 bg-white p-5 shadow-panel dark:border-white/10 dark:bg-white/5';
const ghostButton =
  'inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-extrabold text-slate-700 transition hover:border-brand-300 hover:text-brand-700 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-slate-200';
const primaryButton =
  'inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-extrabold text-white transition hover:bg-brand-700 disabled:opacity-50';
const field =
  'mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold dark:border-white/10 dark:bg-white/5';

const PRIORITIES: readonly TaskPriority[] = ['low', 'normal', 'high', 'urgent'];

function priorityLabel(messages: Messages, priority: TaskPriority): string {
  if (priority === 'low') return messages.priorityLow;
  if (priority === 'high') return messages.priorityHigh;
  if (priority === 'urgent') return messages.priorityUrgent;
  return messages.priorityNormal;
}

function taskStatusLabel(messages: Messages, status: TaskRecord['status']): string {
  if (status === 'completed') return messages.taskStatusCompleted;
  if (status === 'cancelled') return messages.taskStatusCancelled;
  return messages.taskStatusActive;
}

function assignmentStatusLabel(
  messages: Messages,
  status: TaskAssignmentRecord['status'],
): string {
  if (status === 'in_progress') return messages.assignmentInProgress;
  if (status === 'submitted') return messages.assignmentSubmitted;
  if (status === 'accepted') return messages.assignmentAccepted;
  if (status === 'returned') return messages.assignmentReturned;
  return messages.assignmentAssigned;
}

const priorityTone: Record<TaskPriority, string> = {
  low: 'bg-slate-200 text-slate-700 dark:bg-white/10 dark:text-slate-300',
  normal: 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-200',
  high: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200',
  urgent: 'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-200',
};

export function TasksPage({
  locale,
  messages,
  permissions,
  actorEmployeeId,
  focusResourceId = null,
}: {
  locale: Locale;
  messages: Messages;
  permissions: readonly string[];
  actorEmployeeId: string | null;
  /** Task a notification deep link asked this screen to open. */
  focusResourceId?: string | null;
}) {
  const canView = canViewTasks(permissions);
  const canCreate = canCreateTasks(permissions);
  const canEdit = canEditTasks(permissions);
  const canReview = canReviewTasks(permissions);
  const canComment = canCommentOnTasks(permissions);
  const canProgress = canProgressOwnTasks(permissions);

  const [phase, setPhase] = useState<ResourcePhase>(canView ? 'loading' : 'forbidden');
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [scope, setScope] = useState<TaskScope | ''>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [comments, setComments] = useState<TaskCommentRecord[]>([]);
  const [commentCursor, setCommentCursor] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [eligible, setEligible] = useState<TaskEligibleEmployee[]>([]);
  const [draft, setDraft] = useState({
    title: '',
    description: '',
    priority: 'normal' as TaskPriority,
    dueDate: '',
    employeeIds: [] as string[],
  });

  const [editOpen, setEditOpen] = useState(false);
  const [editDraft, setEditDraft] = useState({
    title: '',
    description: '',
    priority: 'normal' as TaskPriority,
    dueDate: '',
  });

  const guard = useRef(createLatestRequestGuard());
  const commentGuard = useRef(createLatestRequestGuard());

  const load = useCallback(async () => {
    if (!canView) {
      setPhase('forbidden');
      return;
    }
    const requestId = guard.current.begin();
    setPhase('loading');
    setActionError(null);
    try {
      const rows = await tasksApi.list(scope ? { scope } : {});
      if (!guard.current.isCurrent(requestId)) return;
      setTasks(rows);
      setPhase(rows.length === 0 ? 'empty' : 'ready');
    } catch (error) {
      if (!guard.current.isCurrent(requestId)) return;
      setPhase(error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error');
    }
  }, [canView, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Open the record a notification pointed at, once the list that contains it
   * has loaded. Selection is only applied when the task is actually present in
   * the permission-filtered response — a deep link never widens what the server
   * decided this account may see.
   */
  useEffect(() => {
    if (!focusResourceId) return;
    if (tasks.some((task) => task.id === focusResourceId)) setSelectedId(focusResourceId);
  }, [focusResourceId, tasks]);

  const selected = useMemo(
    () => tasks.find((task) => task.id === selectedId) ?? null,
    [selectedId, tasks],
  );

  const loadComments = useCallback(async (taskId: string) => {
    const requestId = commentGuard.current.begin();
    try {
      const page = await tasksApi.listComments(taskId, { limit: 30 });
      if (!commentGuard.current.isCurrent(requestId)) return;
      setComments(page.items);
      setCommentCursor(page.nextCursor);
    } catch {
      if (!commentGuard.current.isCurrent(requestId)) return;
      setComments([]);
      setCommentCursor(null);
    }
  }, []);

  useEffect(() => {
    if (!selectedId) {
      commentGuard.current.invalidate();
      setComments([]);
      setCommentCursor(null);
      return;
    }
    void loadComments(selectedId);
  }, [loadComments, selectedId]);

  const openCreate = async () => {
    setActionError(null);
    setDraft({ title: '', description: '', priority: 'normal', dueDate: '', employeeIds: [] });
    setCreateOpen(true);
    try {
      setEligible(await tasksApi.eligibleEmployees());
    } catch {
      setEligible([]);
    }
  };

  const submitCreate = async () => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await tasksApi.create({
        title: draft.title.trim(),
        description: draft.description.trim() || null,
        priority: draft.priority,
        dueDate: draft.dueDate || null,
        employeeIds: draft.employeeIds,
      });
      setCreateOpen(false);
      await load();
    } catch (error) {
      setActionError(
        error instanceof ApiError && error.messageKey ? error.messageKey : messages.tasksError,
      );
    } finally {
      setBusy(false);
    }
  };

  const openEdit = (task: TaskRecord) => {
    setActionError(null);
    setEditDraft({
      title: task.title,
      description: task.description ?? '',
      priority: task.priority,
      dueDate: task.dueDate ?? '',
    });
    setEditOpen(true);
  };

  const submitEdit = async () => {
    if (!selected || busy) return;
    if (!selected.updatedAt) return;
    setBusy(true);
    setActionError(null);
    try {
      await tasksApi.update(selected.id, {
        // Optimistic-concurrency token straight from the record on screen.
        expectedUpdatedAt: selected.updatedAt,
        title: editDraft.title.trim(),
        description: editDraft.description.trim() || null,
        priority: editDraft.priority,
        dueDate: editDraft.dueDate || null,
      });
      setEditOpen(false);
      await load();
    } catch (error) {
      setActionError(
        error instanceof ApiError && error.status === 409
          ? messages.taskConflict
          : messages.tasksError,
      );
    } finally {
      setBusy(false);
    }
  };

  const runAction = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await action();
      await load();
      if (selectedId) await loadComments(selectedId);
    } catch (error) {
      setActionError(
        error instanceof ApiError && error.status === 409
          ? messages.conflictRefresh
          : messages.tasksError,
      );
    } finally {
      setBusy(false);
    }
  };

  const submitComment = async () => {
    if (!selected || !commentDraft.trim() || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await tasksApi.addComment(selected.id, commentDraft.trim());
      setCommentDraft('');
      await loadComments(selected.id);
    } catch (error) {
      setActionError(
        error instanceof ApiError && error.status === 409
          ? messages.conflictRefresh
          : messages.tasksError,
      );
    } finally {
      setBusy(false);
    }
  };

  const loadOlderComments = async () => {
    if (!selected || !commentCursor || busy) return;
    setBusy(true);
    try {
      const page = await tasksApi.listComments(selected.id, {
        cursor: commentCursor,
        limit: 30,
      });
      setComments((current) => [...current, ...page.items]);
      setCommentCursor(page.nextCursor);
    } catch {
      setActionError(messages.tasksError);
    } finally {
      setBusy(false);
    }
  };

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', { dateStyle: 'medium' }),
    [locale],
  );
  const stampFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', {
        dateStyle: 'short',
        timeStyle: 'short',
      }),
    [locale],
  );

  /** The assignment belonging to the signed-in employee, if any. */
  const ownAssignment = selected?.assignments.find(
    (assignment) => actorEmployeeId && assignment.employee.id === actorEmployeeId,
  );

  return (
    <div className="mx-auto max-w-7xl">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-950 dark:text-white sm:text-3xl">
            {messages.tasksTitle}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-500 dark:text-slate-400">
            {messages.tasksSubtitle}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canCreate ? (
            <button type="button" onClick={() => void openCreate()} className={primaryButton}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              {messages.createTask}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void load()}
            disabled={phase === 'loading' || !canView}
            className={ghostButton}
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {messages.refresh}
          </button>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm font-bold text-slate-600 dark:text-slate-300">
          <span>{messages.taskScope}</span>
          <select
            value={scope}
            onChange={(event) => {
              setScope(event.target.value as TaskScope | '');
              setSelectedId(null);
            }}
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-bold dark:border-white/10 dark:bg-white/5"
          >
            <option value="">{messages.allCategories}</option>
            <option value="own">{messages.scopeOwn}</option>
            <option value="department">{messages.scopeDepartment}</option>
            <option value="company">{messages.scopeCompany}</option>
          </select>
        </label>
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
          emptyMessage={messages.tasksEmpty}
          errorMessage={messages.tasksError}
          forbiddenMessage={messages.tasksForbidden}
          onRetry={() => void load()}
        />
      ) : (
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="overflow-x-auto rounded-3xl border border-slate-200 bg-white shadow-panel dark:border-white/10 dark:bg-white/5">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-start text-xs font-extrabold uppercase tracking-wider text-slate-400 dark:bg-white/5">
                <tr>
                  <th className="px-5 py-4 text-start">{messages.taskTitleLabel}</th>
                  <th className="px-5 py-4 text-start">{messages.taskPriority}</th>
                  <th className="px-5 py-4 text-start">{messages.taskDueDate}</th>
                  <th className="px-5 py-4 text-start">{messages.taskStatus}</th>
                  <th className="px-5 py-4" />
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr
                    key={task.id}
                    className={`border-t border-slate-100 dark:border-white/10 ${
                      selectedId === task.id ? 'bg-brand-50 dark:bg-brand-500/10' : ''
                    }`}
                  >
                    <td className="px-5 py-4 font-extrabold text-slate-950 dark:text-white">
                      {task.title}
                    </td>
                    <td className="px-5 py-4">
                      <span
                        className={`inline-flex rounded-lg px-2.5 py-1 text-xs font-extrabold ${priorityTone[task.priority]}`}
                      >
                        {priorityLabel(messages, task.priority)}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-slate-600 dark:text-slate-300">
                      {task.dueDate ? dateFormatter.format(new Date(task.dueDate)) : '—'}
                    </td>
                    <td className="px-5 py-4 text-slate-600 dark:text-slate-300">
                      {taskStatusLabel(messages, task.status)}
                    </td>
                    <td className="px-5 py-4">
                      <button
                        type="button"
                        onClick={() => setSelectedId(task.id)}
                        className={ghostButton}
                      >
                        {messages.viewDetails}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <aside className={panel}>
            {selected ? (
              <>
                <div className="flex items-start justify-between gap-3">
                  <h2 className="text-lg font-extrabold text-slate-950 dark:text-white">
                    {selected.title}
                  </h2>
                  {canEdit && selected.status === 'active' ? (
                    <button
                      type="button"
                      onClick={() => openEdit(selected)}
                      className={ghostButton}
                    >
                      <Pencil className="h-4 w-4" aria-hidden="true" />
                      {messages.editTask}
                    </button>
                  ) : null}
                </div>

                <dl className="mt-4 grid gap-3 text-sm">
                  <div>
                    <dt className="text-xs font-bold text-slate-400">{messages.taskDescription}</dt>
                    <dd className="mt-1 whitespace-pre-line font-semibold">
                      {selected.description ?? '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-bold text-slate-400">{messages.taskCreator}</dt>
                    <dd className="mt-1 font-semibold">{selected.creator.name}</dd>
                  </div>
                </dl>

                <h3 className="mt-6 text-sm font-extrabold text-slate-950 dark:text-white">
                  {messages.taskAssignees}
                </h3>
                <ul className="mt-3 space-y-2">
                  {selected.assignments.map((assignment) => (
                    <li
                      key={assignment.id}
                      className="rounded-xl border border-slate-100 px-3 py-2 dark:border-white/10"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-extrabold">{assignment.employee.name}</span>
                        <span className="text-xs font-bold text-slate-500">
                          {assignmentStatusLabel(messages, assignment.status)}
                        </span>
                      </div>
                      {canReview && assignment.status === 'submitted' ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void runAction(() =>
                                tasksApi.review(assignment.id, { action: 'accept' }),
                              )
                            }
                            className={ghostButton}
                          >
                            {messages.acceptTask}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              const note = window.prompt(messages.reviewNote);
                              if (!note) return;
                              void runAction(() =>
                                tasksApi.review(assignment.id, {
                                  action: 'return',
                                  reviewNote: note,
                                }),
                              );
                            }}
                            className={ghostButton}
                          >
                            {messages.returnTask}
                          </button>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>

                {canProgress && ownAssignment && selected.status === 'active' ? (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {(ownAssignment.status === 'assigned' ||
                      ownAssignment.status === 'returned') ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void runAction(() =>
                            tasksApi.updateProgress(ownAssignment.id, { status: 'in_progress' }),
                          )
                        }
                        className={ghostButton}
                      >
                        {messages.startTask}
                      </button>
                    ) : null}
                    {ownAssignment.status !== 'accepted' &&
                    ownAssignment.status !== 'submitted' ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          const details = window.prompt(messages.completionDetails);
                          if (!details) return;
                          void runAction(() =>
                            tasksApi.updateProgress(ownAssignment.id, {
                              status: 'submitted',
                              completionDetails: details,
                            }),
                          );
                        }}
                        className={ghostButton}
                      >
                        {messages.submitTask}
                      </button>
                    ) : null}
                  </div>
                ) : null}

                <h3 className="mt-6 flex items-center gap-2 text-sm font-extrabold text-slate-950 dark:text-white">
                  <MessageSquare className="h-4 w-4" aria-hidden="true" />
                  {messages.taskComments}
                </h3>
                <ul className="mt-3 space-y-2">
                  {comments.length === 0 ? (
                    <li className="text-sm font-bold text-slate-500">
                      {messages.taskCommentsEmpty}
                    </li>
                  ) : (
                    comments.map((comment) => (
                      <li
                        key={comment.id}
                        className="rounded-xl border border-slate-100 px-3 py-2 dark:border-white/10"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-extrabold">{comment.author.name}</span>
                          <span className="text-xs font-bold text-slate-400">
                            {comment.createdAt
                              ? stampFormatter.format(new Date(comment.createdAt))
                              : '—'}
                          </span>
                        </div>
                        <p className="mt-1 whitespace-pre-line text-sm">{comment.body}</p>
                      </li>
                    ))
                  )}
                </ul>
                {commentCursor ? (
                  <button
                    type="button"
                    onClick={() => void loadOlderComments()}
                    disabled={busy}
                    className={`${ghostButton} mt-3`}
                  >
                    {messages.loadOlder}
                  </button>
                ) : null}

                {canComment && selected.status === 'active' ? (
                  <div className="mt-4">
                    <textarea
                      value={commentDraft}
                      onChange={(event) => setCommentDraft(event.target.value)}
                      placeholder={messages.commentPlaceholder}
                      rows={3}
                      className={field}
                    />
                    <button
                      type="button"
                      onClick={() => void submitComment()}
                      disabled={busy || !commentDraft.trim()}
                      className={`${primaryButton} mt-2`}
                    >
                      {messages.addComment}
                    </button>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="text-sm font-bold text-slate-500">{messages.viewDetails}</p>
            )}
          </aside>
        </div>
      )}

      {createOpen ? (
        <div className="fixed inset-0 z-40 grid place-items-center bg-slate-950/55 p-4 backdrop-blur-sm">
          <div className="max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-3xl bg-white p-6 dark:bg-[#09172b]">
            <h2 className="text-lg font-extrabold">{messages.createTask}</h2>
            <label className="mt-4 block text-sm font-bold">
              {messages.taskTitleLabel}
              <input
                value={draft.title}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                className={field}
              />
            </label>
            <label className="mt-3 block text-sm font-bold">
              {messages.taskDescription}
              <textarea
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                rows={3}
                className={field}
              />
            </label>
            <label className="mt-3 block text-sm font-bold">
              {messages.taskPriority}
              <select
                value={draft.priority}
                onChange={(event) =>
                  setDraft({ ...draft, priority: event.target.value as TaskPriority })
                }
                className={field}
              >
                {PRIORITIES.map((value) => (
                  <option key={value} value={value}>
                    {priorityLabel(messages, value)}
                  </option>
                ))}
              </select>
            </label>
            <label className="mt-3 block text-sm font-bold">
              {messages.taskDueDate}
              <input
                type="date"
                value={draft.dueDate}
                onChange={(event) => setDraft({ ...draft, dueDate: event.target.value })}
                className={field}
              />
            </label>
            <fieldset className="mt-3">
              <legend className="text-sm font-bold">{messages.selectEmployees}</legend>
              {eligible.length === 0 ? (
                <p className="mt-2 text-sm font-bold text-slate-500">
                  {messages.noEligibleEmployees}
                </p>
              ) : (
                <div className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-xl border border-slate-200 p-3 dark:border-white/10">
                  {eligible.map((employee) => (
                    <label
                      key={employee.employeeId}
                      className="flex items-center gap-2 text-sm font-semibold"
                    >
                      <input
                        type="checkbox"
                        checked={draft.employeeIds.includes(employee.employeeId)}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            employeeIds: event.target.checked
                              ? [...draft.employeeIds, employee.employeeId]
                              : draft.employeeIds.filter((id) => id !== employee.employeeId),
                          })
                        }
                        className="h-4 w-4 rounded border-slate-300"
                      />
                      {employee.name}
                      <span className="text-xs text-slate-400">{employee.departmentName ?? ''}</span>
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setCreateOpen(false)} className={ghostButton}>
                {messages.cancel}
              </button>
              <button
                type="button"
                onClick={() => void submitCreate()}
                disabled={busy || !draft.title.trim() || draft.employeeIds.length === 0}
                className={primaryButton}
              >
                {messages.createTask}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {editOpen && selected ? (
        <div className="fixed inset-0 z-40 grid place-items-center bg-slate-950/55 p-4 backdrop-blur-sm">
          <div className="max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-3xl bg-white p-6 dark:bg-[#09172b]">
            <h2 className="text-lg font-extrabold">{messages.editTask}</h2>
            <label className="mt-4 block text-sm font-bold">
              {messages.taskTitleLabel}
              <input
                value={editDraft.title}
                onChange={(event) => setEditDraft({ ...editDraft, title: event.target.value })}
                className={field}
              />
            </label>
            <label className="mt-3 block text-sm font-bold">
              {messages.taskDescription}
              <textarea
                value={editDraft.description}
                onChange={(event) =>
                  setEditDraft({ ...editDraft, description: event.target.value })
                }
                rows={3}
                className={field}
              />
            </label>
            <label className="mt-3 block text-sm font-bold">
              {messages.taskPriority}
              <select
                value={editDraft.priority}
                onChange={(event) =>
                  setEditDraft({ ...editDraft, priority: event.target.value as TaskPriority })
                }
                className={field}
              >
                {PRIORITIES.map((value) => (
                  <option key={value} value={value}>
                    {priorityLabel(messages, value)}
                  </option>
                ))}
              </select>
            </label>
            <label className="mt-3 block text-sm font-bold">
              {messages.taskDueDate}
              <input
                type="date"
                value={editDraft.dueDate}
                onChange={(event) => setEditDraft({ ...editDraft, dueDate: event.target.value })}
                className={field}
              />
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setEditOpen(false)} className={ghostButton}>
                {messages.cancel}
              </button>
              <button
                type="button"
                onClick={() => void submitEdit()}
                disabled={busy || !editDraft.title.trim()}
                className={primaryButton}
              >
                {messages.saveTask}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
