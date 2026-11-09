package com.example.core.session

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.example.domain.model.CurrentSession
import org.json.JSONArray
import org.json.JSONObject

/**
 * Session persistence backed by EncryptedSharedPreferences (AES-256).
 *
 * Tokens are encrypted at rest — never stored in plain SharedPreferences.
 * Construction can throw on devices with a broken Keystore; callers should
 * catch and fall back to a memory-only session (see DependencyProvider).
 */
class EncryptedSessionStore(context: Context) : SessionStore {

    private val prefs: SharedPreferences = run {
        val appContext = context.applicationContext
        val masterKey = MasterKey.Builder(appContext)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            appContext,
            PREFS_FILE,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    override fun save(session: CurrentSession) {
        prefs.edit().putString(KEY_SESSION, toJson(session)).apply()
    }

    override fun load(): CurrentSession? {
        val raw = prefs.getString(KEY_SESSION, null) ?: return null
        return try {
            fromJson(raw)
        } catch (e: Exception) {
            // Corrupt payload: drop it rather than crash the app on startup.
            clear()
            null
        }
    }

    override fun clear() {
        prefs.edit().remove(KEY_SESSION).apply()
    }

    private fun toJson(session: CurrentSession): String {
        val json = JSONObject()
        json.put("companyId", session.companyId)
        json.put("companyCode", session.companyCode)
        json.put("companyName", session.companyName)
        json.put("userId", session.userId)
        json.put("employeeId", session.employeeId ?: JSONObject.NULL)
        json.put("roleId", session.roleId ?: JSONObject.NULL)
        json.put("departmentId", session.departmentId ?: JSONObject.NULL)
        json.put("permissions", JSONArray(session.permissions.toList()))
        json.put("token", session.token ?: JSONObject.NULL)
        json.put("refreshToken", session.refreshToken ?: JSONObject.NULL)
        json.put("email", session.email)
        json.put("name", session.name)
        json.put("role", session.role)
        json.put("authorizationVersion", session.authorizationVersion)
        json.put("mustChangePassword", session.mustChangePassword)
        json.put("mfaProtected", session.mfaProtected)
        json.put("mfaVerifiedAt", session.mfaVerifiedAt ?: JSONObject.NULL)
        return json.toString()
    }

    private fun fromJson(raw: String): CurrentSession {
        val json = JSONObject(raw)
        val permissionsArray = json.optJSONArray("permissions") ?: JSONArray()
        val permissions = buildSet {
            for (i in 0 until permissionsArray.length()) add(permissionsArray.getString(i))
        }
        fun optNullableString(key: String): String? =
            if (json.isNull(key)) null else json.optString(key)
        return CurrentSession(
            companyId = json.getString("companyId"),
            companyCode = json.getString("companyCode"),
            companyName = json.getString("companyName"),
            userId = json.getString("userId"),
            employeeId = optNullableString("employeeId"),
            roleId = optNullableString("roleId"),
            departmentId = optNullableString("departmentId"),
            permissions = permissions,
            token = optNullableString("token"),
            refreshToken = optNullableString("refreshToken"),
            email = json.optString("email", ""),
            name = json.optString("name", ""),
            role = json.optString("role", ""),
            authorizationVersion = json.optInt("authorizationVersion", 0),
            mustChangePassword = json.optBoolean("mustChangePassword", false),
            // Pre-MFA encrypted sessions must reauthenticate once; treating an
            // absent field as unprotected would allow an owner biometric bypass.
            mfaProtected = if (json.has("mfaProtected")) {
                json.optBoolean("mfaProtected", false)
            } else {
                true
            },
            mfaVerifiedAt = optNullableString("mfaVerifiedAt")
        )
    }

    private companion object {
        const val PREFS_FILE = "mawared_secure_session"
        const val KEY_SESSION = "current_session"
    }
}
