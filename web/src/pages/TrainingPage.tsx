import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Award, ClipboardList, RefreshCw } from 'lucide-react';
import { ApiError } from '@/api/client';
import { trainingApi } from '@/collaboration/api';
import type {
  TrainingAssignmentRecord,
  TrainingCertificateRecord,
  TrainingEvaluationRecord,
  TrainingRecommendation,
} from '@/collaboration/types';
import { ResourceState, type ResourcePhase } from '@/components/ResourceState';
import type { Locale, Messages } from '@/i18n';
import {
  canCreateTrainingEvaluation,
  canIssueTrainingCertificate,
  canViewTraining,
  canViewTrainingEvaluation,
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

const RECOMMENDATIONS: readonly TrainingRecommendation[] = [
  'recommended',
  'recommended_with_follow_up',
  'repeat_required',
];

function statusLabel(messages: Messages, status: TrainingAssignmentRecord['status']): string {
  if (status === 'in_progress') return messages.trainingStatusInProgress;
  if (status === 'submitted') return messages.trainingStatusSubmitted;
  if (status === 'completed') return messages.trainingStatusCompleted;
  if (status === 'returned') return messages.trainingStatusReturned;
  if (status === 'cancelled') return messages.trainingStatusCancelled;
  return messages.trainingStatusAssigned;
}

function recommendationLabel(messages: Messages, value: TrainingRecommendation): string {
  if (value === 'recommended_with_follow_up') return messages.recommendationFollowUp;
  if (value === 'repeat_required') return messages.recommendationRepeat;
  return messages.recommendationRecommended;
}

export function TrainingPage({
  locale,
  messages,
  permissions,
  focusResourceId = null,
}: {
  locale: Locale;
  messages: Messages;
  permissions: readonly string[];
  /** Training assignment a notification deep link asked this screen to open. */
  focusResourceId?: string | null;
}) {
  const canView = canViewTraining(permissions);
  const canIssue = canIssueTrainingCertificate(permissions);
  const canEvaluate = canCreateTrainingEvaluation(permissions);
  const canReadEvaluation = canViewTrainingEvaluation(permissions);

  const [phase, setPhase] = useState<ResourcePhase>(canView ? 'loading' : 'forbidden');
  const [assignments, setAssignments] = useState<TrainingAssignmentRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [certificate, setCertificate] = useState<TrainingCertificateRecord | null>(null);
  const [evaluation, setEvaluation] = useState<TrainingEvaluationRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [evaluationOpen, setEvaluationOpen] = useState(false);
  const [evaluationDraft, setEvaluationDraft] = useState({
    effectivenessScore: 3,
    knowledgeScore: 3,
    applicationScore: 3,
    recommendation: 'recommended' as TrainingRecommendation,
    comment: '',
  });

  const guard = useRef(createLatestRequestGuard());
  const detailGuard = useRef(createLatestRequestGuard());

  const load = useCallback(async () => {
    if (!canView) {
      setPhase('forbidden');
      return;
    }
    const requestId = guard.current.begin();
    setPhase('loading');
    setActionError(null);
    try {
      const page = await trainingApi.listAssignments({ pageSize: 100 });
      if (!guard.current.isCurrent(requestId)) return;
      setAssignments(page.items);
      setPhase(page.items.length === 0 ? 'empty' : 'ready');
    } catch (error) {
      if (!guard.current.isCurrent(requestId)) return;
      setPhase(error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error');
    }
  }, [canView]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Only selects when the assignment is present in the permission-filtered list. */
  useEffect(() => {
    if (!focusResourceId) return;
    if (assignments.some((assignment) => assignment.id === focusResourceId)) {
      setSelectedId(focusResourceId);
    }
  }, [assignments, focusResourceId]);

  const selected = useMemo(
    () => assignments.find((assignment) => assignment.id === selectedId) ?? null,
    [assignments, selectedId],
  );

  /**
   * Certificate and evaluation are fetched independently: a 404 means "not
   * issued / not recorded" and is a normal state, not an error. The evaluation
   * request is skipped entirely without the view permission so the UI never
   * provokes a 403 it would then have to explain away.
   */
  const loadDetail = useCallback(
    async (assignmentId: string) => {
      const requestId = detailGuard.current.begin();
      setCertificate(null);
      setEvaluation(null);
      const [certificateResult, evaluationResult] = await Promise.allSettled([
        trainingApi.getCertificate(assignmentId),
        canReadEvaluation
          ? trainingApi.getEvaluation(assignmentId)
          : Promise.reject(new ApiError(403, 'Forbidden')),
      ]);
      if (!detailGuard.current.isCurrent(requestId)) return;
      if (certificateResult.status === 'fulfilled') setCertificate(certificateResult.value);
      if (evaluationResult.status === 'fulfilled') setEvaluation(evaluationResult.value);
    },
    [canReadEvaluation],
  );

  useEffect(() => {
    if (!selectedId) {
      detailGuard.current.invalidate();
      setCertificate(null);
      setEvaluation(null);
      return;
    }
    void loadDetail(selectedId);
  }, [loadDetail, selectedId]);

  const issueCertificate = async () => {
    if (!selected || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      setCertificate(await trainingApi.issueCertificate(selected.id));
    } catch (error) {
      setActionError(
        error instanceof ApiError && error.status === 409
          ? messages.conflictRefresh
          : messages.trainingError,
      );
    } finally {
      setBusy(false);
    }
  };

  const submitEvaluation = async () => {
    if (!selected || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const created = await trainingApi.createEvaluation(selected.id, {
        effectivenessScore: evaluationDraft.effectivenessScore,
        knowledgeScore: evaluationDraft.knowledgeScore,
        applicationScore: evaluationDraft.applicationScore,
        recommendation: evaluationDraft.recommendation,
        comment: evaluationDraft.comment.trim() || null,
      });
      setEvaluation(created);
      setEvaluationOpen(false);
    } catch (error) {
      setActionError(
        error instanceof ApiError && error.status === 409
          ? messages.evaluationExists
          : messages.trainingError,
      );
    } finally {
      setBusy(false);
    }
  };

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', { dateStyle: 'medium' }),
    [locale],
  );

  return (
    <div className="mx-auto max-w-7xl">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-950 dark:text-white sm:text-3xl">
            {messages.trainingTitle}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-500 dark:text-slate-400">
            {messages.trainingSubtitle}
          </p>
        </div>
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

      {actionError ? (
        <p role="alert" className="mt-4 text-sm font-bold text-red-600 dark:text-red-300">
          {actionError}
        </p>
      ) : null}

      {phase !== 'ready' ? (
        <ResourceState
          phase={phase}
          messages={messages}
          emptyMessage={messages.trainingEmpty}
          errorMessage={messages.trainingError}
          forbiddenMessage={messages.trainingForbidden}
          onRetry={() => void load()}
        />
      ) : (
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="overflow-x-auto rounded-3xl border border-slate-200 bg-white shadow-panel dark:border-white/10 dark:bg-white/5">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-start text-xs font-extrabold uppercase tracking-wider text-slate-400 dark:bg-white/5">
                <tr>
                  <th className="px-5 py-4 text-start">{messages.trainingCourse}</th>
                  <th className="px-5 py-4 text-start">{messages.trainingEmployee}</th>
                  <th className="px-5 py-4 text-start">{messages.trainingProgress}</th>
                  <th className="px-5 py-4 text-start">{messages.taskStatus}</th>
                  <th className="px-5 py-4" />
                </tr>
              </thead>
              <tbody>
                {assignments.map((assignment) => (
                  <tr
                    key={assignment.id}
                    className={`border-t border-slate-100 dark:border-white/10 ${
                      selectedId === assignment.id ? 'bg-brand-50 dark:bg-brand-500/10' : ''
                    }`}
                  >
                    <td className="px-5 py-4 font-extrabold text-slate-950 dark:text-white">
                      {assignment.course?.title ?? '—'}
                    </td>
                    <td className="px-5 py-4 text-slate-600 dark:text-slate-300">
                      {assignment.employee.displayName}
                    </td>
                    <td className="px-5 py-4 text-slate-600 dark:text-slate-300" dir="ltr">
                      {assignment.progressPercent}%
                    </td>
                    <td className="px-5 py-4 text-slate-600 dark:text-slate-300">
                      {statusLabel(messages, assignment.status)}
                    </td>
                    <td className="px-5 py-4">
                      <button
                        type="button"
                        onClick={() => setSelectedId(assignment.id)}
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
                <h2 className="text-lg font-extrabold text-slate-950 dark:text-white">
                  {selected.course?.title ?? '—'}
                </h2>
                <dl className="mt-4 grid gap-3 text-sm">
                  <div>
                    <dt className="text-xs font-bold text-slate-400">{messages.trainingEmployee}</dt>
                    <dd className="mt-1 font-semibold">{selected.employee.displayName}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-bold text-slate-400">{messages.taskStatus}</dt>
                    <dd className="mt-1 font-semibold">{statusLabel(messages, selected.status)}</dd>
                  </div>
                  {selected.score !== null ? (
                    <div>
                      <dt className="text-xs font-bold text-slate-400">{messages.trainingScore}</dt>
                      <dd className="mt-1 font-semibold" dir="ltr">{selected.score}</dd>
                    </div>
                  ) : null}
                </dl>

                <h3 className="mt-6 flex items-center gap-2 text-sm font-extrabold text-slate-950 dark:text-white">
                  <Award className="h-4 w-4" aria-hidden="true" />
                  {messages.certificate}
                </h3>
                {certificate ? (
                  <dl className="mt-3 grid gap-2 text-sm">
                    <div>
                      <dt className="text-xs font-bold text-slate-400">
                        {messages.certificateSerial}
                      </dt>
                      <dd className="mt-1 font-extrabold" dir="ltr">
                        {certificate.serialNumber}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-bold text-slate-400">
                        {messages.certificateIssuedAt}
                      </dt>
                      <dd className="mt-1 font-semibold">
                        {certificate.issuedAt
                          ? dateFormatter.format(new Date(certificate.issuedAt))
                          : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-bold text-slate-400">
                        {messages.certificateIssuedBy}
                      </dt>
                      <dd className="mt-1 font-semibold">{certificate.issuedBy?.name ?? '—'}</dd>
                    </div>
                    <p className="mt-1 text-xs font-bold text-slate-400">
                      {messages.certificateInternalNote}
                    </p>
                  </dl>
                ) : (
                  <p className="mt-3 text-sm font-bold text-slate-500">{messages.certificateNone}</p>
                )}
                {canIssue && !certificate && selected.status === 'completed' ? (
                  <button
                    type="button"
                    onClick={() => void issueCertificate()}
                    disabled={busy}
                    className={`${primaryButton} mt-3`}
                  >
                    {messages.issueCertificate}
                  </button>
                ) : null}

                <h3 className="mt-6 flex items-center gap-2 text-sm font-extrabold text-slate-950 dark:text-white">
                  <ClipboardList className="h-4 w-4" aria-hidden="true" />
                  {messages.evaluation}
                </h3>
                {!canReadEvaluation ? (
                  <p className="mt-3 text-sm font-bold text-slate-500">
                    {messages.evaluationRestricted}
                  </p>
                ) : evaluation ? (
                  <dl className="mt-3 grid gap-2 text-sm">
                    <div className="flex justify-between gap-3">
                      <dt className="text-xs font-bold text-slate-400">
                        {messages.effectivenessScore}
                      </dt>
                      <dd className="font-extrabold" dir="ltr">{evaluation.effectivenessScore}/5</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-xs font-bold text-slate-400">{messages.knowledgeScore}</dt>
                      <dd className="font-extrabold" dir="ltr">{evaluation.knowledgeScore}/5</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-xs font-bold text-slate-400">
                        {messages.applicationScore}
                      </dt>
                      <dd className="font-extrabold" dir="ltr">{evaluation.applicationScore}/5</dd>
                    </div>
                    <div>
                      <dt className="text-xs font-bold text-slate-400">{messages.recommendation}</dt>
                      <dd className="mt-1 font-semibold">
                        {recommendationLabel(messages, evaluation.recommendation)}
                      </dd>
                    </div>
                    {evaluation.comment ? (
                      <div>
                        <dt className="text-xs font-bold text-slate-400">
                          {messages.evaluationComment}
                        </dt>
                        <dd className="mt-1 whitespace-pre-line font-semibold">
                          {evaluation.comment}
                        </dd>
                      </div>
                    ) : null}
                    <div>
                      <dt className="text-xs font-bold text-slate-400">{messages.evaluatedBy}</dt>
                      <dd className="mt-1 font-semibold">{evaluation.evaluatedBy?.name ?? '—'}</dd>
                    </div>
                  </dl>
                ) : (
                  <p className="mt-3 text-sm font-bold text-slate-500">{messages.evaluationNone}</p>
                )}
                {canEvaluate && !evaluation && selected.status === 'completed' ? (
                  <button
                    type="button"
                    onClick={() => setEvaluationOpen(true)}
                    disabled={busy}
                    className={`${ghostButton} mt-3`}
                  >
                    {messages.createEvaluation}
                  </button>
                ) : null}
              </>
            ) : (
              <p className="text-sm font-bold text-slate-500">{messages.viewDetails}</p>
            )}
          </aside>
        </div>
      )}

      {evaluationOpen && selected ? (
        <div className="fixed inset-0 z-40 grid place-items-center bg-slate-950/55 p-4 backdrop-blur-sm">
          <div className="max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-3xl bg-white p-6 dark:bg-[#09172b]">
            <h2 className="text-lg font-extrabold">{messages.createEvaluation}</h2>
            {(
              [
                ['effectivenessScore', messages.effectivenessScore],
                ['knowledgeScore', messages.knowledgeScore],
                ['applicationScore', messages.applicationScore],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="mt-3 block text-sm font-bold">
                {label}
                <select
                  value={evaluationDraft[key]}
                  onChange={(event) =>
                    setEvaluationDraft({
                      ...evaluationDraft,
                      [key]: Number(event.target.value),
                    })
                  }
                  className={field}
                >
                  {[1, 2, 3, 4, 5].map((score) => (
                    <option key={score} value={score}>
                      {score}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <label className="mt-3 block text-sm font-bold">
              {messages.recommendation}
              <select
                value={evaluationDraft.recommendation}
                onChange={(event) =>
                  setEvaluationDraft({
                    ...evaluationDraft,
                    recommendation: event.target.value as TrainingRecommendation,
                  })
                }
                className={field}
              >
                {RECOMMENDATIONS.map((value) => (
                  <option key={value} value={value}>
                    {recommendationLabel(messages, value)}
                  </option>
                ))}
              </select>
            </label>
            <label className="mt-3 block text-sm font-bold">
              {messages.evaluationComment}
              <textarea
                value={evaluationDraft.comment}
                onChange={(event) =>
                  setEvaluationDraft({ ...evaluationDraft, comment: event.target.value })
                }
                rows={3}
                className={field}
              />
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEvaluationOpen(false)}
                className={ghostButton}
              >
                {messages.cancel}
              </button>
              <button
                type="button"
                onClick={() => void submitEvaluation()}
                disabled={busy}
                className={primaryButton}
              >
                {messages.createEvaluation}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
