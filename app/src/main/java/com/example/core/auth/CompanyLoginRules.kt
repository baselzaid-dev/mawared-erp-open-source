package com.example.core.auth

import java.util.Locale

object CompanyLoginRules {
    private val companyCodePattern = Regex("^[A-Z0-9]+(?:-[A-Z0-9]+)*$")

    fun normalizeCompanyCode(value: String): String =
        value.trim().uppercase(Locale.ROOT)

    fun isValidCompanyCode(value: String): Boolean {
        val normalized = normalizeCompanyCode(value)
        return normalized.length in 3..32 && companyCodePattern.matches(normalized)
    }

    fun isValidIdentifier(value: String): Boolean {
        val normalized = value.trim()
        if (normalized.isEmpty() || normalized.length > 320) return false
        return normalized.none {
            Character.getType(it) == Character.CONTROL.toInt() ||
                Character.getType(it) == Character.FORMAT.toInt()
        }
    }

    fun matchesRememberedCompany(input: String, rememberedCompanyCode: String?): Boolean =
        rememberedCompanyCode != null &&
            normalizeCompanyCode(input) == normalizeCompanyCode(rememberedCompanyCode)

    fun canSubmit(
        companyCode: String,
        identifier: String,
        password: String,
        isLoading: Boolean
    ): Boolean =
        !isLoading &&
            isValidCompanyCode(companyCode) &&
            isValidIdentifier(identifier) &&
            password.isNotBlank()
}
