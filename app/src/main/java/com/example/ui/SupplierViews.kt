package com.example.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.Business
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.Unarchive
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.example.R
import com.example.domain.model.Supplier
import com.example.domain.model.VendorLifecycleRules
import com.example.domain.model.isArchived
import com.example.ui.theme.*
import com.example.ui.ux.MawaredEmailField
import com.example.ui.ux.MawaredScrollableForm
import com.example.ui.ux.MawaredTextField

private fun vendorStatusLabel(status: String) = when (status) {
    "active" -> "نشط"
    "inactive" -> "غير نشط"
    "archived" -> "مؤرشف"
    else -> status
}

private fun vendorStatusColor(status: String) = when (status) {
    "active" -> EmeraldMain
    "archived" -> SlateLight
    else -> RedStatus
}

@Composable
fun SuppliersTabContent(viewModel: MawaredViewModel, purchasingUiState: PurchasingUiState) {
    var search by remember { mutableStateOf("") }
    var status by remember { mutableStateOf<String?>(null) }
    var editing by remember { mutableStateOf<Supplier?>(null) }
    var creating by remember { mutableStateOf(false) }
    var archiveTarget by remember { mutableStateOf<Supplier?>(null) }
    var reactivateTarget by remember { mutableStateOf<Supplier?>(null) }
    val lifecycleState by viewModel.vendorLifecycleController.state.collectAsState()

    LaunchedEffect(lifecycleState) {
        val success = lifecycleState as? VendorLifecycleUiState.SuccessMessage ?: return@LaunchedEffect
        if (archiveTarget?.id == success.vendorId || reactivateTarget?.id == success.vendorId) {
            viewModel.showNotification(success.message)
            archiveTarget = null
            reactivateTarget = null
            viewModel.vendorLifecycleController.dismissFeedback()
        }
    }

    val supplierSource = viewModel.focusedVendor?.let(::listOf) ?: purchasingUiState.suppliers
    val visible = supplierSource.filter { supplier ->
        (status == null || supplier.status == status) && supplier.name.contains(search, true)
    }
    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(
            search,
            {
                viewModel.clearTypedResourceFocus()
                search = it
            },
            label = { Text("بحث عن مورد") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true
        )
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            listOf(null to "الكل", "active" to "نشط", "inactive" to "غير نشط", "archived" to "مؤرشف").forEach { (key, label) ->
                FilterChip(
                    selected = status == key,
                    onClick = {
                        viewModel.clearTypedResourceFocus()
                        status = key
                    },
                    label = { Text(label) }
                )
            }
        }
        if (purchasingUiState.canManageSuppliers) Button(onClick = { creating = true }, modifier = Modifier.fillMaxWidth()) { Icon(Icons.Default.PersonAdd, null); Spacer(Modifier.width(8.dp)); Text("إضافة مورد") }
        Spacer(Modifier.height(8.dp))
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(visible, key = { it.id }) { supplier ->
                val busyKind = (lifecycleState as? VendorLifecycleUiState.Submitting)
                    ?.takeIf { it.vendorId == supplier.id }
                    ?.kind
                Card(Modifier.fillMaxWidth(), shape = androidx.compose.foundation.shape.RoundedCornerShape(8.dp)) {
                    Column(Modifier.padding(14.dp)) {
                        Row(Modifier.fillMaxWidth()) {
                            Icon(Icons.Default.Business, null, tint = EmeraldMain)
                            Spacer(Modifier.width(8.dp))
                            Column(Modifier.weight(1f)) {
                                Text(supplier.name, fontWeight = FontWeight.Bold)
                                Text(supplier.category ?: "بدون تصنيف", style = MaterialTheme.typography.bodySmall, color = SlateLight)
                            }
                            Text(vendorStatusLabel(supplier.status), color = vendorStatusColor(supplier.status), fontWeight = FontWeight.Bold)
                        }
                        supplier.phone?.let { Text("التواصل: $it", style = MaterialTheme.typography.bodySmall) }
                        supplier.email?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                        if (supplier.isArchived && !supplier.archiveReason.isNullOrBlank()) {
                            Text("سبب الأرشفة: ${supplier.archiveReason}", style = MaterialTheme.typography.bodySmall, color = SlateLight)
                        }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                            if (purchasingUiState.canManageSuppliers && !supplier.isArchived) {
                                TextButton(onClick = { editing = supplier }) { Text("تعديل") }
                                TextButton(onClick = { viewModel.setSupplierStatus(supplier.id, if (supplier.status == "active") "inactive" else "active") }) {
                                    Text(if (supplier.status == "active") "تعطيل" else "تفعيل", color = if (supplier.status == "active") RedStatus else EmeraldMain)
                                }
                            }
                            if (VendorLifecycleRules.canArchive(supplier, purchasingUiState.canArchiveVendors)) {
                                TextButton(onClick = { archiveTarget = supplier }, enabled = busyKind == null) {
                                    Icon(Icons.Default.Archive, contentDescription = null, tint = RedStatus)
                                    Spacer(Modifier.width(4.dp))
                                    Text("أرشفة", color = RedStatus)
                                }
                            }
                            if (VendorLifecycleRules.canReactivate(supplier, purchasingUiState.canArchiveVendors)) {
                                TextButton(onClick = { reactivateTarget = supplier }, enabled = busyKind == null) {
                                    Icon(Icons.Default.Unarchive, contentDescription = null, tint = EmeraldMain)
                                    Spacer(Modifier.width(4.dp))
                                    Text("إعادة تفعيل", color = EmeraldMain)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    if (creating) SupplierDialog(null, onDismiss = { creating = false }) { viewModel.createSupplier(it); creating = false }
    editing?.let { supplier -> SupplierDialog(supplier, onDismiss = { editing = null }) { viewModel.updateSupplier(supplier.id, it); editing = null } }

    archiveTarget?.let { supplier ->
        val submitting = (lifecycleState as? VendorLifecycleUiState.Submitting)
            ?.let { it.vendorId == supplier.id && it.kind == VendorLifecycleActionKind.ARCHIVE } ?: false
        val error = (lifecycleState as? VendorLifecycleUiState.Error)
            ?.takeIf { it.vendorId == supplier.id && it.kind == VendorLifecycleActionKind.ARCHIVE }
            ?.message
        VendorArchiveConfirmDialog(
            vendorName = supplier.name,
            isSubmitting = submitting,
            errorMessage = error,
            onDismiss = {
                if (!submitting) {
                    archiveTarget = null
                    viewModel.vendorLifecycleController.dismissFeedback()
                }
            },
            onConfirm = { reason ->
                viewModel.vendorLifecycleController.archiveVendor(
                    vendor = supplier,
                    reason = reason,
                    hasArchivePermission = purchasingUiState.canArchiveVendors
                )
            }
        )
    }

    reactivateTarget?.let { supplier ->
        val submitting = (lifecycleState as? VendorLifecycleUiState.Submitting)
            ?.let { it.vendorId == supplier.id && it.kind == VendorLifecycleActionKind.REACTIVATE } ?: false
        val error = (lifecycleState as? VendorLifecycleUiState.Error)
            ?.takeIf { it.vendorId == supplier.id && it.kind == VendorLifecycleActionKind.REACTIVATE }
            ?.message
        VendorReactivateConfirmDialog(
            vendorName = supplier.name,
            isSubmitting = submitting,
            errorMessage = error,
            onDismiss = {
                if (!submitting) {
                    reactivateTarget = null
                    viewModel.vendorLifecycleController.dismissFeedback()
                }
            },
            onConfirm = { reason ->
                viewModel.vendorLifecycleController.reactivateVendor(
                    vendor = supplier,
                    reason = reason,
                    hasArchivePermission = purchasingUiState.canArchiveVendors
                )
            }
        )
    }
}

@Composable
private fun SupplierDialog(existing: Supplier?, onDismiss: () -> Unit, onSubmit: (Supplier) -> Unit) {
    var name by remember { mutableStateOf(existing?.name.orEmpty()) }
    var phone by remember { mutableStateOf(existing?.phone.orEmpty()) }
    var email by remember { mutableStateOf(existing?.email.orEmpty()) }
    var tax by remember { mutableStateOf(existing?.taxNumber.orEmpty()) }
    var category by remember { mutableStateOf(existing?.category.orEmpty()) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                stringResource(
                    if (existing == null) R.string.supplier_add_title else R.string.supplier_edit_title
                )
            )
        },
        text = {
            MawaredScrollableForm(
                modifier = Modifier.fillMaxWidth(),
                content = {
                    MawaredTextField(
                        value = name,
                        onValueChange = { name = it },
                        label = stringResource(R.string.supplier_name),
                        imeAction = ImeAction.Next
                    )
                    Spacer(Modifier.height(6.dp))
                    MawaredTextField(
                        value = phone,
                        onValueChange = { phone = it },
                        label = stringResource(R.string.supplier_phone),
                        keyboardType = KeyboardType.Phone,
                        forceLtr = true,
                        imeAction = ImeAction.Next
                    )
                    Spacer(Modifier.height(6.dp))
                    MawaredEmailField(
                        value = email,
                        onValueChange = { email = it },
                        label = stringResource(R.string.supplier_email),
                        imeAction = ImeAction.Next
                    )
                    Spacer(Modifier.height(6.dp))
                    MawaredTextField(
                        value = tax,
                        onValueChange = { tax = it },
                        label = stringResource(R.string.supplier_tax_number),
                        forceLtr = true,
                        imeAction = ImeAction.Next
                    )
                    Spacer(Modifier.height(6.dp))
                    MawaredTextField(
                        value = category,
                        onValueChange = { category = it },
                        label = stringResource(R.string.supplier_category),
                        imeAction = ImeAction.Done
                    )
                }
            )
        },
        confirmButton = {
            Button(
                enabled = name.isNotBlank(),
                onClick = {
                    onSubmit(
                        Supplier(
                            existing?.id.orEmpty(),
                            existing?.companyId.orEmpty(),
                            name.trim(),
                            phone.trim().ifEmpty { null },
                            email.trim().ifEmpty { null },
                            tax.trim().ifEmpty { null },
                            category.trim().ifEmpty { null },
                            existing?.status ?: "active",
                            existing?.deactivatedAt,
                            existing?.createdAt,
                            existing?.updatedAt
                        )
                    )
                }
            ) {
                Text(stringResource(R.string.ux_unsaved_save))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.ux_cancel))
            }
        }
    )
}
