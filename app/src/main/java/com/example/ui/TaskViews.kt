package com.example.ui

import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.example.BuildConfig
import com.example.R
import com.example.data.demo.DemoLoginProfiles
import com.example.data.model.Employee
import com.example.data.model.PurchaseOrder
import com.example.data.model.ChatMessage
import com.example.data.model.Task
import com.example.data.model.TrainingCourse
import com.example.data.model.TrainingAssignment
import com.example.ui.theme.*
import com.example.ui.ux.MawaredScrollableForm
import com.example.ui.ux.MawaredTextField
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Locale

@Composable
private fun LegacyMawaredDailyTasks(
    viewModel: MawaredViewModel,
    user: LoggedInState.Authenticated
) {
    /* Legacy Sprint 4 demo UI retained temporarily beside the production workflow.
    val tasksUiState by viewModel.tasksUiState.collectAsState()
    val tasks = tasksUiState.tasks
    // Only managers/admins may create or delete tasks. Normal employees can only
    // mark their tasks done/not-done (the checkbox in TaskCardRow).
    val canManageTasks = tasksUiState.canCreate

    var isAddTaskDialogOpen by remember { mutableStateOf(false) }
    var taskTitle by remember { mutableStateOf("") }
    var taskDesc by remember { mutableStateOf("") }
    var taskPriority by remember { mutableStateOf("متوسطة") }
    var taskDue by remember { mutableStateOf("اليوم") }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column {
                Text(
                    "تنبيهات المهام الإدارية اليومية",
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                    color = if (viewModel.isDarkTheme) Color.White else SlateDark
                )
                Text(
                    "متابعة المهام التشغيلية اليومية والتنبيهات المباشرة للموظفين",
                    fontSize = 11.sp,
                    color = SlateLight
                )
            }

            // Task creation is a manager/admin action only.
            if (canManageTasks) {
                Button(
                    onClick = { isAddTaskDialogOpen = true },
                    colors = ButtonDefaults.buttonColors(containerColor = EmeraldMain),
                    shape = RoundedCornerShape(8.dp)
                ) {
                    Icon(Icons.Default.AddTask, contentDescription = "مهمة", tint = SlateDark)
                    Spacer(modifier = Modifier.width(4.dp))
                    Text("إضافة مهمة", color = SlateDark, fontWeight = FontWeight.Bold)
                }
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        if (tasks.isEmpty()) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Default.AssignmentTurnedIn, contentDescription = "لا يوجد", tint = SlateLight, modifier = Modifier.size(64.dp))
                    Text("لا توجد مهام حالياً. استمتع بيومك!", color = SlateLight, modifier = Modifier.padding(top = 10.dp))
                }
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                items(tasks) { task ->
                    TaskCardRow(
                        task = task,
                        canDelete = canManageTasks,
                        onCheckedChange = { isChecked -> viewModel.toggleTask(task.id, isChecked) },
                        onDelete = { viewModel.removeTask(task.id) }
                    )
                }
            }
        }
    }

    if (isAddTaskDialogOpen) {
        Dialog(onDismissRequest = { isAddTaskDialogOpen = false }) {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(16.dp),
                color = if (viewModel.isDarkTheme) SlateMedium else Color.White
            ) {
                MawaredScrollableForm(modifier = Modifier.padding(20.dp)) {
                    Text(
                        "إضافة مهمة إدارية عاجلة",
                        fontWeight = FontWeight.Bold,
                        style = MaterialTheme.typography.titleMedium,
                        color = if (viewModel.isDarkTheme) Color.White else SlateDark
                    )
                    Spacer(modifier = Modifier.height(12.dp))

                    MawaredTextField(
                        value = taskTitle,
                        onValueChange = { taskTitle = it },
                        label = "عنوان المهمة"
                    )
                    Spacer(modifier = Modifier.height(8.dp))

                    MawaredTextField(
                        value = taskDesc,
                        onValueChange = { taskDesc = it },
                        label = "تفاصيل وتوجيه وبند العمل"
                    )
                    Spacer(modifier = Modifier.height(8.dp))

                    Text("الأولوية والاستعجال:", style = MaterialTheme.typography.bodySmall, color = SlateLight)
                    val prioritiesList = listOf("عالية", "متوسطة", "منخفضة")
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        prioritiesList.forEach { p ->
                            val s = taskPriority == p
                            FilterChip(
                                selected = s,
                                onClick = { taskPriority = p },
                                label = { Text(p, fontSize = 11.sp) }
                            )
                        }
                    }
                    Spacer(modifier = Modifier.height(8.dp))

                    MawaredTextField(
                        value = taskDue,
                        onValueChange = { taskDue = it },
                        label = "تاريخ أو وقت التسليم"
                    )

                    Spacer(modifier = Modifier.height(16.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.End
                    ) {
                        TextButton(onClick = { isAddTaskDialogOpen = false }) {
                            Text("الرجوع")
                        }
                        Spacer(modifier = Modifier.width(8.dp))
                        Button(
                            onClick = {
                                if (taskTitle.isNotEmpty()) {
                                    viewModel.addNewTask(taskTitle, taskDesc, taskPriority, taskDue)
                                    isAddTaskDialogOpen = false
                                    taskTitle = ""
                                    taskDesc = ""
                                } else {
                                    viewModel.showNotification("خطأ: الرجاء كتابة عنوان المهمة اليومية!")
                                }
                            },
                            colors = ButtonDefaults.buttonColors(containerColor = EmeraldMain)
                        ) {
                            Text("تثبيت التنبيه الفوري", color = SlateDark, fontWeight = FontWeight.Bold)
                        }
                    }
                }
            }
        }
    }
    */
}

@Composable
private fun LegacyTaskCardRow(
    task: Task,
    canDelete: Boolean = true,
    onCheckedChange: (Boolean) -> Unit,
    onDelete: () -> Unit
) {
    /* Legacy checkbox/delete card. The active Sprint 7 screen never calls it.
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = if (isSystemInDarkTheme()) SlateMedium else Color.White
        )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Row(
                modifier = Modifier.weight(1f),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Checkbox(
                    checked = task.isCompleted,
                    onCheckedChange = onCheckedChange,
                    colors = CheckboxDefaults.colors(checkedColor = EmeraldMain)
                )
                Spacer(modifier = Modifier.width(8.dp))
                Column {
                    Text(
                        task.title,
                        fontWeight = FontWeight.Bold,
                        style = MaterialTheme.typography.bodyLarge,
                        color = if (isSystemInDarkTheme()) Color.White else SlateDark,
                        fontFamily = FontFamily.SansSerif
                    )
                    if (task.description.isNotEmpty()) {
                        Text(
                            task.description,
                            fontSize = 11.sp,
                            color = SlateLight
                        )
                    }
                    Text(
                        "التاريخ المستحق: ${task.dueDate}",
                        fontSize = 10.sp,
                        color = SlateLight
                    )
                }
            }

            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .background(
                            color = when (task.priority) {
                                "عالية" -> RedStatus.copy(alpha = 0.15f)
                                "متوسطة" -> AmberStatus.copy(alpha = 0.15f)
                                else -> SlateLight.copy(alpha = 0.15f)
                            },
                            shape = RoundedCornerShape(6.dp)
                        )
                        .padding(vertical = 4.dp, horizontal = 12.dp)
                ) {
                    Text(
                        task.priority,
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                        color = when (task.priority) {
                            "عالية" -> RedStatus
                            "متوسطة" -> AmberStatus
                            else -> SlateLight
                        }
                    )
                }

                if (canDelete) {
                    Spacer(modifier = Modifier.width(8.dp))
                    IconButton(onClick = onDelete) {
                        Icon(Icons.Default.DeleteOutline, contentDescription = stringResource(R.string.ux_delete_cd), tint = RedStatus)
                    }
                }
            }
        }
    }
    */
}

// ---------------- TRAINING & DEVELOPMENT COMPONENT ----------------
