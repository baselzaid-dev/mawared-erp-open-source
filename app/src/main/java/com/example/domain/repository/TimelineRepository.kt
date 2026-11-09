package com.example.domain.repository

import com.example.core.utils.AppResult
import com.example.domain.model.TimelineEntity
import com.example.domain.model.TimelineKind

interface TimelineRepository {
    suspend fun loadTimeline(kind: TimelineKind, id: String): AppResult<TimelineEntity>
}
