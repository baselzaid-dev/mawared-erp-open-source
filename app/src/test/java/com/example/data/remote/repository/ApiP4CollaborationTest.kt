package com.example.data.remote.repository

import com.example.core.utils.AppResult
import com.example.data.remote.api.TaskActorDto
import com.example.data.remote.api.TaskCommentDto
import com.example.domain.model.TaskFieldEdit
import com.example.domain.model.TrainingEvaluationRequestParams
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Commercial P4 — Android repository behaviour for task edit/comments and the
 * two training completion artifacts.
 *
 * These are real behavioural tests against a fake API (not source-text pattern
 * assertions), and they pin the parts a UI change could silently break: the
 * optimistic-concurrency token actually reaching the wire, a 409 surfacing as an
 * error rather than being retried, and the certificate/evaluation retry
 * semantics differing from each other on purpose.
 */
class ApiP4CollaborationTest {

    // ---- Task edit ----

    @Test
    fun `task edit sends the optimistic-concurrency token and no status field`() = runTest {
        val api = FakeTaskApi()
        val repository = ApiTaskRepository(api)

        val result = repository.updateTask(
            taskId = "t1",
            expectedUpdatedAt = "2026-08-09T10:00:00.000Z",
            title = "  عنوان محدث  ",
            priority = "urgent"
        )

        assertTrue(result is AppResult.Success)
        val json = api.lastUpdateJson
        assertNotNull(json)
        assertTrue(json!!.contains("\"expectedUpdatedAt\":\"2026-08-09T10:00:00.000Z\""))
        // Whitespace is trimmed before it reaches the wire.
        assertTrue(json.contains("\"title\":\"عنوان محدث\""))
        assertTrue(json.contains("\"priority\":\"urgent\""))
        // Untouched fields must be ABSENT, not null: a present null would mean
        // "clear it" and would wipe a field the user never touched.
        assertFalse(json.contains("description"))
        assertFalse(json.contains("dueDate"))
        // status has its own audited transition and must never ride this route.
        assertFalse(json.contains("status"))
    }

    @Test
    fun `clearing a description sends an explicit null, not an omitted field`() = runTest {
        val api = FakeTaskApi()
        val repository = ApiTaskRepository(api)

        // This is the case a plain nullable parameter cannot express: Moshi omits
        // null properties, so without the explicit Set(null) the backend would
        // read the request as "leave the description alone" and — if this were
        // the only edit — reject it for containing no change at all.
        repository.updateTask(
            taskId = "t1",
            expectedUpdatedAt = "2026-08-09T10:00:00.000Z",
            description = TaskFieldEdit.Set(null),
        )

        val json = api.lastUpdateJson
        assertNotNull(json)
        assertTrue("description must be present and null: $json", json!!.contains("\"description\":null"))
        // dueDate was left Unchanged, so it must not appear at all.
        assertFalse(json.contains("dueDate"))
    }

    @Test
    fun `clearing a due date sends an explicit null`() = runTest {
        val api = FakeTaskApi()
        val repository = ApiTaskRepository(api)

        repository.updateTask(
            taskId = "t1",
            expectedUpdatedAt = "2026-08-09T10:00:00.000Z",
            dueDate = TaskFieldEdit.Set(null),
        )

        val json = api.lastUpdateJson
        assertTrue(json!!.contains("\"dueDate\":null"))
        assertFalse(json.contains("description"))
    }

    @Test
    fun `an emptied text box clears rather than storing an empty string`() = runTest {
        val api = FakeTaskApi()
        val repository = ApiTaskRepository(api)

        // The Compose edit dialog always sends Set(currentText); an emptied box
        // must therefore clear the field, not persist "".
        repository.updateTask(
            taskId = "t1",
            expectedUpdatedAt = "2026-08-09T10:00:00.000Z",
            description = TaskFieldEdit.Set("   "),
        )

        assertTrue(api.lastUpdateJson!!.contains("\"description\":null"))
    }

    @Test
    fun `the mock repository applies the same three-state clear rule`() = runTest {
        val repository = com.example.data.repository.mock.MockTaskRepository()
        repository.refreshTasks()
        val created = repository.createTask(
            com.example.domain.model.CreateTaskRequestParams(
                title = "مهمة",
                description = "وصف أصلي",
                priority = "normal",
                dueDate = "2026-12-31",
                employeeIds = listOf("e1"),
            )
        )
        val task = (created as AppResult.Success).data

        // Unchanged keeps the description; Set(null) clears it. Demo mode must
        // not diverge from the API contract here.
        val kept = repository.updateTask(task.id, task.updatedAt!!, title = "عنوان جديد")
        assertEquals("وصف أصلي", (kept as AppResult.Success).data.description)

        val cleared = repository.updateTask(
            task.id,
            kept.data.updatedAt!!,
            description = TaskFieldEdit.Set(null),
        )
        assertNull((cleared as AppResult.Success).data.description)
    }

    @Test
    fun `a concurrent-edit conflict surfaces as an error instead of being retried`() = runTest {
        val api = FakeTaskApi(failWith = 409, errorJson = """{"error":"TASK_EDIT_CONFLICT","message":"تم تعديل المهمة من مستخدم آخر"}""")
        val repository = ApiTaskRepository(api)

        val result = repository.updateTask("t1", "2026-08-09T10:00:00.000Z", title = "x")

        assertTrue(result is AppResult.Error)
        assertTrue((result as AppResult.Error).exception.message!!.contains("مستخدم آخر"))
    }

    // ---- Task comments ----

    @Test
    fun `comment pages carry the keyset cursor through unchanged`() = runTest {
        val api = FakeTaskApi()
        api.comments = listOf(
            TaskCommentDto("c1", "t1", "أول تعليق", TaskActorDto("u1", "مدير"), "2026-08-09T11:00:00.000Z"),
            TaskCommentDto("c2", "t1", "تعليق آخر", TaskActorDto("u2", "موظف"), "2026-08-09T11:05:00.000Z"),
        )
        val repository = ApiTaskRepository(api)

        val page = repository.loadComments("t1", cursor = "opaque-cursor", limit = 30)

        assertTrue(page is AppResult.Success)
        val data = (page as AppResult.Success).data
        assertEquals(2, data.items.size)
        assertEquals("أول تعليق", data.items.first().body)
        assertEquals("مدير", data.items.first().authorName)
        assertEquals("next-cursor", data.nextCursor)
        assertTrue(data.hasMore)
        // The cursor is opaque and must be forwarded verbatim.
        assertEquals("opaque-cursor", api.lastCommentCursor)
    }

    @Test
    fun `adding a comment trims the body and maps the author`() = runTest {
        val api = FakeTaskApi()
        val repository = ApiTaskRepository(api)

        val result = repository.addComment("t1", "  يرجى إرفاق النسخة الموقعة  ")

        assertTrue(result is AppResult.Success)
        assertEquals("يرجى إرفاق النسخة الموقعة", api.lastComment?.body)
        assertEquals("مدير", (result as AppResult.Success).data.authorName)
    }

    @Test
    fun `commenting on a closed task surfaces the server conflict`() = runTest {
        val api = FakeTaskApi(failWith = 409, errorJson = """{"error":"TASK_COMMENT_INVALID","message":"يمكن التعليق على المهام النشطة فقط"}""")
        val repository = ApiTaskRepository(api)

        val result = repository.addComment("t1", "متأخر")

        assertTrue(result is AppResult.Error)
    }

    // ---- Training completion artifacts ----

    @Test
    fun `issuing a certificate twice is safe and returns the same serial`() = runTest {
        val api = FakeTrainingApi()
        val repository = ApiTrainingRepository(api)

        val first = repository.issueCertificate("a1")
        val second = repository.issueCertificate("a1")

        assertTrue(first is AppResult.Success)
        assertTrue(second is AppResult.Success)
        assertEquals(
            (first as AppResult.Success).data.serialNumber,
            (second as AppResult.Success).data.serialNumber,
        )
        // The client does not deduplicate: the server's idempotent issue does.
        assertEquals(2, api.certificateIssueCalls)
    }

    @Test
    fun `certificate mapping keeps the frozen snapshots the server issued`() = runTest {
        val repository = ApiTrainingRepository(FakeTrainingApi())

        val result = repository.loadCertificate("a1")

        assertTrue(result is AppResult.Success)
        val certificate = (result as AppResult.Success).data
        assertEquals("CERT-202608-ABCDEF0123", certificate.serialNumber)
        assertEquals("دورة", certificate.courseTitle)
        assertEquals("موظف", certificate.employeeName)
        assertEquals("مدير", certificate.issuedByName)
    }

    @Test
    fun `evaluation sends bounded scores and a trimmed comment`() = runTest {
        val api = FakeTrainingApi()
        val repository = ApiTrainingRepository(api)

        val result = repository.createEvaluation(
            "a1",
            TrainingEvaluationRequestParams(
                effectivenessScore = 4,
                knowledgeScore = 5,
                applicationScore = 3,
                recommendation = "recommended_with_follow_up",
                comment = "   يحتاج متابعة   ",
            ),
        )

        assertTrue(result is AppResult.Success)
        val sent = api.lastEvaluation
        assertNotNull(sent)
        assertEquals(4, sent!!.effectivenessScore)
        assertEquals("recommended_with_follow_up", sent.recommendation)
        assertEquals("يحتاج متابعة", sent.comment)
    }

    @Test
    fun `a blank evaluation comment is omitted rather than sent as empty text`() = runTest {
        val api = FakeTrainingApi()
        val repository = ApiTrainingRepository(api)

        repository.createEvaluation(
            "a1",
            TrainingEvaluationRequestParams(3, 3, 3, "recommended", comment = "   "),
        )

        assertNull(api.lastEvaluation?.comment)
    }

    @Test
    fun `a duplicate evaluation is reported as an error, never a silent success`() = runTest {
        val api = FakeTrainingApi(failWith = 409, errorJson = """{"error":"TRAINING_EVALUATION_EXISTS","message":"يوجد تقييم مسجل لهذا التكليف بالفعل"}""")
        val repository = ApiTrainingRepository(api)

        val result = repository.createEvaluation(
            "a1",
            TrainingEvaluationRequestParams(1, 1, 1, "repeat_required"),
        )

        assertTrue(result is AppResult.Error)
        assertTrue((result as AppResult.Error).exception.message!!.contains("تقييم مسجل"))
    }

    @Test
    fun `a forbidden evaluation read surfaces the permission error`() = runTest {
        // The backend requires training.evaluation.view; the ordinary training
        // scope is deliberately not enough.
        val api = FakeTrainingApi(failWith = 403, errorJson = """{"error":"Forbidden","message":"لا تملك صلاحية"}""")
        val repository = ApiTrainingRepository(api)

        val result = repository.loadEvaluation("a1")

        assertTrue(result is AppResult.Error)
    }
}
