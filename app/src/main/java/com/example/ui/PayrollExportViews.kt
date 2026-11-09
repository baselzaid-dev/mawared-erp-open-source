package com.example.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.domain.model.PayrollExportFormat
import com.example.domain.model.PayrollPeriodParams
import com.example.domain.model.canExportPayroll
import com.example.ui.theme.EmeraldMain

/**
 * Sprint 12H — payroll exports (v2). Requires BOTH `payroll.report` and `reports.export`
 * (mirrors the backend's checkPayrollExportPermissions), same rule as the rest of the
 * app's reports export flow.
 */
@Composable
fun PayrollExportActions(
    period: PayrollPeriodParams,
    exportingFormat: PayrollExportFormat?,
    onExport: (PayrollExportFormat) -> Unit
) {
    if (!period.canExportPayroll()) return
    Row(
        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(top = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        PayrollExportFormat.entries.forEach { format ->
            OutlinedButton(
                onClick = { onExport(format) },
                enabled = exportingFormat == null,
                shape = RoundedCornerShape(6.dp)
            ) {
                if (exportingFormat == format) {
                    CircularProgressIndicator(
                        modifier = Modifier.height(14.dp).width(14.dp).padding(end = 4.dp),
                        color = EmeraldMain
                    )
                }
                Text("تصدير ${format.apiValue.uppercase()}", fontSize = 11.sp)
            }
        }
    }
}
