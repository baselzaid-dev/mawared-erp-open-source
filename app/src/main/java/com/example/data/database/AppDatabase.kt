package com.example.data.database

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import com.example.data.model.Employee
import com.example.data.model.PurchaseOrder
import com.example.data.model.ChatMessage
import com.example.data.model.Task
import com.example.data.model.TrainingCourse
import com.example.data.model.TrainingAssignment

@Database(
    entities = [
        Employee::class,
        PurchaseOrder::class,
        ChatMessage::class,
        Task::class,
        TrainingCourse::class,
        TrainingAssignment::class
    ],
    version = 4,
    exportSchema = false
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun mawaredDao(): MawaredDao

    companion object {
        @Volatile
        private var INSTANCE: AppDatabase? = null

        fun getDatabase(context: Context): AppDatabase {
            return INSTANCE ?: synchronized(this) {
                val instance = Room.databaseBuilder(
                    context.applicationContext,
                    AppDatabase::class.java,
                    "mawared_erp_database"
                )
                .fallbackToDestructiveMigration()
                .build()
                INSTANCE = instance
                instance
            }
        }
    }
}
