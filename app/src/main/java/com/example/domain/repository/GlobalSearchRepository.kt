package com.example.domain.repository

import com.example.core.utils.AppResult
import com.example.domain.model.GlobalSearchPage

interface GlobalSearchRepository {
    suspend fun search(
        query: String,
        types: List<String>? = null,
        cursor: Int? = null,
        limit: Int? = null
    ): AppResult<GlobalSearchPage>
}
