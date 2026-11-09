package com.example.data.remote.repository

import android.content.Context
import android.net.Uri
import android.util.Base64
import com.example.core.attachment.AttachmentCacheStore
import com.example.core.attachment.CachedAttachmentFile
import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.data.remote.api.AttachmentApi
import com.example.data.remote.api.AttachmentMetadataDto
import com.example.data.remote.api.AttachmentUploadRequestDto
import java.io.ByteArrayOutputStream

data class AttachmentMetadata(
    val id: String,
    val originalFilename: String,
    val contentType: String,
    val byteSize: Int,
    val purpose: String,
    val purchaseOrderId: String?,
    val chatMessageId: String?
)

class ApiAttachmentRepository(
    private val api: AttachmentApi,
    private val cacheStore: AttachmentCacheStore,
    private val appContext: Context
) {
    private fun AttachmentMetadataDto.toDomain() = AttachmentMetadata(
        id = id,
        originalFilename = originalFilename,
        contentType = contentType,
        byteSize = byteSize,
        purpose = purpose,
        purchaseOrderId = purchaseOrderId,
        chatMessageId = chatMessageId
    )

    suspend fun uploadFromUri(
        uri: Uri,
        purpose: String,
        purchaseOrderId: String? = null,
        conversationId: String? = null,
        chatMessageId: String? = null
    ): AppResult<AttachmentMetadata> {
        return try {
            val resolver = appContext.contentResolver
            val mime = resolver.getType(uri)?.substringBefore(';')?.trim().orEmpty()
                .ifBlank { "application/octet-stream" }
            val name = queryDisplayName(uri) ?: "attachment.bin"
            val bytes = resolver.openInputStream(uri)?.use { input ->
                val out = ByteArrayOutputStream()
                val buffer = ByteArray(8 * 1024)
                var total = 0
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    total += read
                    if (total > AttachmentCacheStore.MAX_BYTES) {
                        return AppResult.Error(
                            Exception("too large"),
                            AppError.ValidationError("حجم المرفق يتجاوز 5 ميغابايت")
                        )
                    }
                    out.write(buffer, 0, read)
                }
                out.toByteArray()
            } ?: return AppResult.Error(
                Exception("unreadable"),
                AppError.ValidationError("تعذّر قراءة الملف")
            )

            val response = api.upload(
                AttachmentUploadRequestDto(
                    purpose = purpose,
                    originalFilename = name,
                    contentType = mime,
                    contentBase64 = Base64.encodeToString(bytes, Base64.NO_WRAP),
                    purchaseOrderId = purchaseOrderId,
                    conversationId = conversationId,
                    chatMessageId = chatMessageId
                )
            )
            val body = response.body()
            if (!response.isSuccessful || body == null) {
                AppResult.Error(
                    Exception(response.message()),
                    AppError.ServerError(response.code(), response.message().ifBlank { "تعذّر رفع المرفق" })
                )
            } else {
                AppResult.Success(body.toDomain())
            }
        } catch (e: Exception) {
            AppResult.Error(e, AppError.NetworkError)
        }
    }

    suspend fun listForPurchaseOrder(orderId: String): AppResult<List<AttachmentMetadata>> {
        return try {
            val response = api.list(purchaseOrderId = orderId, purpose = "purchasing")
            val body = response.body()
            if (!response.isSuccessful || body == null) {
                AppResult.Error(
                    Exception(response.message()),
                    AppError.ServerError(response.code(), response.message().ifBlank { "تعذّر تحميل المرفقات" })
                )
            } else {
                AppResult.Success(body.map { it.toDomain() })
            }
        } catch (e: Exception) {
            AppResult.Error(e, AppError.NetworkError)
        }
    }

    suspend fun downloadToCache(id: String): AppResult<CachedAttachmentFile> {
        return try {
            val metaResponse = api.metadata(id)
            val meta = metaResponse.body()
            if (!metaResponse.isSuccessful || meta == null) {
                return AppResult.Error(
                    Exception(metaResponse.message()),
                    AppError.ServerError(metaResponse.code(), metaResponse.message().ifBlank { "تعذّر تنزيل المرفق" })
                )
            }
            val contentResponse = api.content(id)
            val body = contentResponse.body()
            if (!contentResponse.isSuccessful || body == null) {
                return AppResult.Error(
                    Exception(contentResponse.message()),
                    AppError.ServerError(contentResponse.code(), contentResponse.message().ifBlank { "تعذّر تنزيل المرفق" })
                )
            }
            val bytes = body.bytes()
            if (bytes.size > AttachmentCacheStore.MAX_BYTES) {
                return AppResult.Error(
                    Exception("too large"),
                    AppError.ValidationError("حجم المرفق يتجاوز الحد المسموح")
                )
            }
            AppResult.Success(cacheStore.save(bytes, meta.originalFilename, meta.contentType))
        } catch (e: Exception) {
            AppResult.Error(e, AppError.NetworkError)
        }
    }

    fun openViewerIntent(file: CachedAttachmentFile): android.content.Intent =
        cacheStore.openViewerIntent(file)

    private fun queryDisplayName(uri: Uri): String? {
        val cursor = appContext.contentResolver.query(uri, null, null, null, null) ?: return null
        cursor.use {
            val index = it.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
            if (index < 0 || !it.moveToFirst()) return null
            return it.getString(index)
        }
    }
}
