package com.example.data.repository

import com.example.data.database.MawaredDao
import com.example.data.model.Employee
import com.example.data.model.PurchaseOrder
import com.example.data.model.ChatMessage
import com.example.data.model.Task
import com.example.data.model.TrainingCourse
import com.example.data.model.TrainingAssignment
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first

class MawaredRepository(private val dao: MawaredDao) {

    val employees: Flow<List<Employee>> = dao.getAllEmployees()
    val purchaseOrders: Flow<List<PurchaseOrder>> = dao.getAllPurchaseOrders()
    val tasks: Flow<List<Task>> = dao.getAllTasks()
    val trainingCourses: Flow<List<TrainingCourse>> = dao.getAllTrainingCourses()
    val trainingAssignments: Flow<List<TrainingAssignment>> = dao.getAllTrainingAssignments()

    // ---------------- EMPLOYEE METHODS ----------------
    suspend fun addEmployee(employee: Employee) {
        dao.insertEmployee(employee)
    }

    suspend fun updateEmployee(employee: Employee) {
        dao.updateEmployee(employee)
    }

    suspend fun deleteEmployee(id: String) {
        dao.deleteEmployeeById(id)
    }

    // ---------------- PROCUREMENT OPERATIONS ----------------
    suspend fun addPurchaseOrder(order: PurchaseOrder) {
        dao.insertPurchaseOrder(order)
    }

    suspend fun updateOrderStatus(id: String, status: String) {
        dao.updatePurchaseOrderStatus(id, status)
    }

    suspend fun deletePurchaseOrder(id: String) {
        dao.deletePurchaseOrderById(id)
    }

    // ---------------- CHAT METHODS ----------------
    // LEGACY_COMPATIBILITY_ONLY: Chat is migrated to ChatRepository/MockChatRepository. These
    // methods (and the seeded Room chat rows) are no longer used by the Chat screen and can be
    // removed once the Room chat_messages table/seed is dropped.
    fun getChatMessages(channel: String): Flow<List<ChatMessage>> {
        return dao.getMessagesByChannel(channel)
    }

    suspend fun sendChatMessage(message: ChatMessage) {
        dao.insertChatMessage(message)
    }

    // ---------------- TASK METHODS ----------------
    suspend fun addTask(task: Task) {
        dao.insertTask(task)
    }

    suspend fun toggleTask(id: String, isCompleted: Boolean) {
        dao.toggleTaskCompleted(id, isCompleted)
    }

    // ---------------- TRAINING METHODS ----------------
    suspend fun addTrainingCourse(course: TrainingCourse) {
        dao.insertTrainingCourse(course)
    }

    suspend fun updateTrainingCourse(course: TrainingCourse) {
        dao.updateTrainingCourse(course)
    }

    suspend fun deleteTrainingCourse(id: String) {
        dao.deleteTrainingCourseById(id)
    }

    suspend fun assignEmployeeToCourse(assignment: TrainingAssignment) {
        dao.insertTrainingAssignment(assignment)
    }

    suspend fun updateAssignmentProgress(id: String, progress: Int, status: String) {
        dao.updateAssignmentProgress(id, progress, status)
    }

    suspend fun deleteAssignment(id: String) {
        dao.deleteTrainingAssignmentById(id)
    }

    // Seeding function to pre-populate DB with premium corporate data
    suspend fun seedDatabaseIfEmpty() {
        // Quick check using Employees Flow
        val currentEmployees = employees.first()
        if (currentEmployees.isEmpty()) {
            // Seed Employees
            val seedEmployees = listOf(
                Employee(
                    name = "موظف تجريبي 3",
                    email = "a.otaibi@fixture-1.example.test",
                    phone = "0500000001",
                    role = "مدير الموارد البشرية",
                    department = "الموارد البشرية",
                    basicSalary = 16000.0,
                    allowances = 2500.0,
                    deductions = 500.0,
                    joinedDate = "2020-01-15",
                    status = "نشط"
                ),
                Employee(
                    name = "موظف تجريبي 4",
                    email = "s.ghamdi@fixture-1.example.test",
                    phone = "0500000002",
                    role = "مديرة الشؤون المالية",
                    department = "الشؤون المالية",
                    basicSalary = 15000.0,
                    allowances = 2000.0,
                    deductions = 300.0,
                    joinedDate = "2021-03-10",
                    status = "نشط"
                ),
                Employee(
                    name = "موظف تجريبي 1",
                    email = "m.shammari@fixture-1.example.test",
                    phone = "0500000003",
                    role = "مطور تطبيقات أول",
                    department = "تكنولوجيا المعلومات",
                    basicSalary = 14000.0,
                    allowances = 1800.0,
                    deductions = 1500.0,
                    joinedDate = "2022-06-01",
                    status = "نشط"
                ),
                Employee(
                    name = "موظف تجريبي 8",
                    email = "h.qahtani@fixture-1.example.test",
                    phone = "0500000004",
                    role = "أخصائية علاقات عامة",
                    department = "التسويق",
                    basicSalary = 9000.0,
                    allowances = 1000.0,
                    deductions = 200.0,
                    joinedDate = "2023-11-20",
                    status = "في إجازة"
                ),
                Employee(
                    name = "موظف تجريبي 2",
                    email = "k.yousef@fixture-1.example.test",
                    phone = "0500000005",
                    role = "مسؤول المشتريات",
                    department = "المشتريات",
                    basicSalary = 10000.0,
                    allowances = 1200.0,
                    deductions = 400.0,
                    joinedDate = "2024-02-01",
                    status = "نشط"
                )
            )
            for (emp in seedEmployees) {
                dao.insertEmployee(emp)
            }

            // Seed Purchase Orders
            val seedOrders = listOf(
                PurchaseOrder(
                    title = "أجهزة لابتوب MacBook M3 لفريق التقنية",
                    requester = "موظف تجريبي 2",
                    department = "تكنولوجيا المعلومات",
                    amount = "45000.00",
                    date = "2026-06-01",
                    status = "تمت الموافقة",
                    category = "أجهزة ومعدات"
                ),
                PurchaseOrder(
                    title = "اشتراكات تراخيص السحابة AWS ومخدمات المطورين",
                    requester = "موظف تجريبي 4",
                    department = "تكنولوجيا المعلومات",
                    amount = "18500.00",
                    date = "2026-06-10",
                    status = "قيد الانتظار",
                    category = "برمجيات"
                ),
                PurchaseOrder(
                    title = "أثاث ومكاتب مريحة للمقر الجديد (مساحة العمل المشتركة)",
                    requester = "موظف تجريبي 3",
                    department = "الموارد البشرية",
                    amount = "32000.00",
                    date = "2026-06-05",
                    status = "تمت الموافقة",
                    category = "مستلزمات مكتبية"
                ),
                PurchaseOrder(
                    title = "حملة إعلانية رقمية للربع الثاني للترويج للمنتج الجديد",
                    requester = "موظف تجريبي 8",
                    department = "التسويق",
                    amount = "15000.00",
                    date = "2026-06-11",
                    status = "مرفوض",
                    category = "أخرى"
                )
            )
            for (order in seedOrders) {
                dao.insertPurchaseOrder(order)
            }

            // Seed Chat Messages
            val seedMessages = listOf(
                ChatMessage(
                    senderName = "موظف تجريبي 3",
                    senderRole = "مدير الموارد البشرية",
                    content = "السلام عليكم ورحمة الله وبركاته، نرجو من جميع مدراء الأقسام تعبئة مراجعات الأداء السنوية لموظفيهم قبل يوم الخميس القادم لربطها بالرواتب والبدلات السنوية.",
                    channel = "العامة"
                ),
                ChatMessage(
                    senderName = "موظف تجريبي 4",
                    senderRole = "مديرة الشؤون المالية",
                    content = "وعليكم السلام، جاري تحديث نظام الاستحقاق المالي وربط البدلات مباشرة للحساب البنكي، ونظام المشتريات أصبح مرتبطاً بشكل كامل بالموازنة الشهرية.",
                    channel = "المالية والمشتريات"
                ),
                ChatMessage(
                    senderName = "موظف تجريبي 2",
                    senderRole = "مسؤول المشتريات",
                    content = "أهلاً سارة، لقد أنشأت طلب مالي لشراء أجهزة حواسيب جديدة، أرجو مراجعته والموافقة عليه لصرف الدفعة للوكيل المعتمد.",
                    channel = "المالية والمشتريات"
                ),
                ChatMessage(
                    senderName = "موظف تجريبي 3",
                    senderRole = "مدير الموارد البشرية",
                    content = "أهلاً بفريق الموارد البشرية، لدينا مقابلة غداً صباحاً لوظيفة محاسب أول مالي، الرجاء تهيئة قاعة الاجتماعات وحضور اللقاء الرئيسي.",
                    channel = "الموارد البشرية"
                )
            )
            for (msg in seedMessages) {
                dao.insertChatMessage(msg)
            }

            // Seed Tasks
            val seedTasks = listOf(
                Task(
                    title = "مراجعة كشوفات رواتب قسم التقنية والبدلات",
                    description = "تأكيد توافق الاستقطاعات الإضافية مع الإجازات الأسبوعية.",
                    dueDate = "اليوم",
                    priority = "عالية",
                    isCompleted = false
                ),
                Task(
                    title = "الموافقة على ترخيص AWS السحابي المعلق",
                    description = "موافقة نهائية من الإدارة المالية للمشتريات.",
                    dueDate = "غداً",
                    priority = "عالية",
                    isCompleted = false
                ),
                Task(
                    title = "مقابلة مرشح مالي لوظيفة محاسب رواتب",
                    description = "القاعة الرئيسية - الساعة العاشرة صباحاً مع أحمد وسارة.",
                    dueDate = "14 يونيو",
                    priority = "متوسطة",
                    isCompleted = true
                ),
                Task(
                    title = "تحديث كتيب الموظف الجديد للشركة لوائح ٢٠٢٦",
                    description = "وضع اللوائح المعتمدة الخاصة بالحوافز المباشرة.",
                    dueDate = "18 يونيو",
                    priority = "منخفضة",
                    isCompleted = false
                )
            )
            for (task in seedTasks) {
                dao.insertTask(task)
            }

            // Seed Training Courses
            val initCourses = listOf(
                TrainingCourse(
                    title = "أساسيات الجودة والأمن السيبراني للمؤسسات",
                    description = "تأهيل كافة الموظفين لحماية أصول الشركة البرمجية والحسّاسة وتطبيق معايير الامتثال الرقمي.",
                    instructor = "د. عبد الله المالكي",
                    startDate = "2026-06-15",
                    endDate = "2026-06-18",
                    resources = "دليل التدقيق الأمني، العروض التقديمية للأمن المؤسسي، مخبر اختبار الاختراق المحاكي",
                    status = "نشط"
                ),
                TrainingCourse(
                    title = "مهارات القيادة وإدارة المشاريع الرشيقة (Agile)",
                    description = "تزويد مدراء الأقسام بالأدوات القيادية اللازمة لإجراء اجتماعات الوقوف اليومية وإدارة سكرم بكفاءة.",
                    instructor = "م. أروى ممدوح",
                    startDate = "2026-07-01",
                    endDate = "2026-07-10",
                    resources = "كتيب سكرم Scrum Guide 2026، منج دراسة الحالة القيادية، قوالب متابعة المهام الرشيقة",
                    status = "مخطط"
                ),
                TrainingCourse(
                    title = "إتقان المحاسبة والتحليل المالي بموارد ERP",
                    description = "شرح تفصيلي لدورة المشتريات المترابطة، الموازنات العامة، وإقراص الرواتب وعلاقتها بـ Room DB اللحظي.",
                    instructor = "عادل فهد (أخصائي تدريب)",
                    startDate = "2026-06-20",
                    endDate = "2026-06-25",
                    resources = "حقيبة المحاسبة المهنية المعتمدة، قراءة وتفصيل الموازنة ودفتر الأستاذ المالي الموحد",
                    status = "نشط"
                )
            )
            for (course in initCourses) {
                dao.insertTrainingCourse(course)
            }

            // Seed Training Assignments
            val initAssignments = listOf(
                TrainingAssignment(
                    courseId = "1",
                    employeeId = "3",
                    employeeName = "موظف تجريبي 1",
                    employeeRole = "مطور تطبيقات أول",
                    progress = 65,
                    status = "قيد الدراسة"
                ),
                TrainingAssignment(
                    courseId = "3",
                    employeeId = "5",
                    employeeName = "موظف تجريبي 2",
                    employeeRole = "مسؤول المشتريات",
                    progress = 100,
                    status = "مكتمل"
                )
            )
            for (assign in initAssignments) {
                dao.insertTrainingAssignment(assign)
            }
        }
    }
}
