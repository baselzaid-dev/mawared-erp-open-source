package com.example.data.database

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update
import com.example.data.model.Employee
import com.example.data.model.PurchaseOrder
import com.example.data.model.ChatMessage
import com.example.data.model.Task
import com.example.data.model.TrainingCourse
import com.example.data.model.TrainingAssignment
import kotlinx.coroutines.flow.Flow

@Dao
interface MawaredDao {
    // ---------------- EMPLOYEE OPERATIONS ----------------
    @Query("SELECT * FROM employees ORDER BY id DESC")
    fun getAllEmployees(): Flow<List<Employee>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertEmployee(employee: Employee)

    @Update
    suspend fun updateEmployee(employee: Employee)

    @Query("DELETE FROM employees WHERE id = :id")
    suspend fun deleteEmployeeById(id: String)

    // ---------------- PROCUREMENT OPERATIONS ----------------
    @Query("SELECT * FROM purchase_orders ORDER BY id DESC")
    fun getAllPurchaseOrders(): Flow<List<PurchaseOrder>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertPurchaseOrder(order: PurchaseOrder)

    @Query("UPDATE purchase_orders SET status = :status WHERE id = :id")
    suspend fun updatePurchaseOrderStatus(id: String, status: String)

    @Query("DELETE FROM purchase_orders WHERE id = :id")
    suspend fun deletePurchaseOrderById(id: String)

    // ---------------- INTERNAL CHAT OPERATIONS ----------------
    @Query("SELECT * FROM chat_messages WHERE channel = :channel ORDER BY timestamp ASC")
    fun getMessagesByChannel(channel: String): Flow<List<ChatMessage>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertChatMessage(message: ChatMessage)

    // ---------------- TASKS OPERATIONS ----------------
    @Query("SELECT * FROM tasks ORDER BY id DESC")
    fun getAllTasks(): Flow<List<Task>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertTask(task: Task)

    @Query("UPDATE tasks SET isCompleted = :isCompleted WHERE id = :id")
    suspend fun toggleTaskCompleted(id: String, isCompleted: Boolean)

    // ---------------- TRAINING OPERATIONS ----------------
    @Query("SELECT * FROM training_courses ORDER BY id DESC")
    fun getAllTrainingCourses(): Flow<List<TrainingCourse>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertTrainingCourse(course: TrainingCourse)

    @Update
    suspend fun updateTrainingCourse(course: TrainingCourse)

    @Query("DELETE FROM training_courses WHERE id = :id")
    suspend fun deleteTrainingCourseById(id: String)

    @Query("SELECT * FROM training_assignments ORDER BY id DESC")
    fun getAllTrainingAssignments(): Flow<List<TrainingAssignment>>

    @Query("SELECT * FROM training_assignments WHERE courseId = :courseId ORDER BY id DESC")
    fun getAssignmentsByCourse(courseId: String): Flow<List<TrainingAssignment>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertTrainingAssignment(assignment: TrainingAssignment)

    @Query("UPDATE training_assignments SET progress = :progress, status = :status WHERE id = :id")
    suspend fun updateAssignmentProgress(id: String, progress: Int, status: String)

    @Query("DELETE FROM training_assignments WHERE id = :id")
    suspend fun deleteTrainingAssignmentById(id: String)
}
