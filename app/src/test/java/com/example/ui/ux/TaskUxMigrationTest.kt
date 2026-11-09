package com.example.ui.ux

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class TaskUxMigrationTest {
    @Test
    fun `task add dialog uses shared scrollable form fields`() {
        val appRoot = listOf(File("."), File("app"))
            .first { File(it, "src/main/AndroidManifest.xml").exists() }
        val source = File(appRoot, "src/main/java/com/example/ui/TaskViews.kt").readText()
        assertTrue(source.contains("MawaredScrollableForm"))
        assertTrue(source.contains("MawaredTextField"))
        assertTrue(source.contains("addNewTask"))
    }
}
