package com.example.security

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class AndroidSecurityConfigTest {
    private val appRoot = listOf(File("."), File("app"))
        .first { File(it, "src/main/AndroidManifest.xml").exists() }

    private fun source(path: String): String = File(appRoot, path).readText()

    /**
     * Drop `//` comment lines so assertions describe the actual build
     * configuration rather than the prose explaining it. Without this, a
     * comment naming the value it forbids would fail its own test.
     */
    private fun executable(source: String): String = source
        .lines()
        .filterNot { it.trimStart().startsWith("//") }
        .joinToString("\n")

    @Test
    fun `release policy blocks cleartext and debug exceptions stay local`() {
        val release = source("src/main/res/xml/network_security_config.xml")
        val debug = source("src/debug/res/xml/network_security_config.xml")
        assertTrue(release.contains("cleartextTrafficPermitted=\"false\""))
        assertFalse(release.contains(">10.0.2.2</domain>"))
        assertFalse(release.contains(">localhost</domain>"))
        assertTrue(debug.contains("10.0.2.2"))
        assertTrue(debug.contains("cleartextTrafficPermitted=\"true\""))
    }

    @Test
    fun `FileProvider is private and session storage is excluded from backup`() {
        val manifest = source("src/main/AndroidManifest.xml")
        val paths = source("src/main/res/xml/report_file_paths.xml")
        val backup = source("src/main/res/xml/backup_rules.xml")
        val extraction = source("src/main/res/xml/data_extraction_rules.xml")
        assertTrue(manifest.contains(".core.export.ReportFileProvider"))
        assertTrue(manifest.contains("android:exported=\"false\""))
        assertTrue(manifest.contains("android:grantUriPermissions=\"true\""))
        assertFalse(manifest.contains("WRITE_EXTERNAL_STORAGE"))
        assertTrue(paths.contains("<cache-path name=\"reports\" path=\"reports\""))
        assertFalse(paths.contains("external-path"))
        assertFalse(paths.contains("root-path"))
        assertTrue(backup.contains("mawared_secure_session.xml"))
        assertTrue(extraction.contains("mawared_secure_session.xml"))
    }

    @Test
    fun `release logging is disabled and auth headers are redacted`() {
        val network = source("src/main/java/com/example/data/remote/api/NetworkModule.kt")
        val policy = source("src/main/java/com/example/core/network/NetworkLoggingPolicy.kt")
        assertTrue(network.contains("NetworkLoggingPolicy.createInterceptor()"))
        assertTrue(policy.contains("BuildConfig.DEBUG"))
        assertTrue(policy.contains("HttpLoggingInterceptor.Level.NONE"))
        assertTrue(policy.contains("\"Authorization\""))
        assertTrue(policy.contains("\"Proxy-Authorization\""))
        assertTrue(policy.contains("\"Cookie\""))
        assertTrue(policy.contains("\"Set-Cookie\""))
        assertTrue(policy.contains("redactHeader"))
        assertFalse(policy.contains("HttpLoggingInterceptor.Level.BODY"))
    }

    @Test
    fun `AI remains backend only and no Gemini key is compiled`() {
        val api = source("src/main/java/com/example/data/remote/api/ApiInterfaces.kt")
        val build = source("build.gradle.kts")
        assertTrue(api.contains("/api/v1/ai/chat"))
        assertFalse(build.contains("libs.plugins.secrets"))
        assertFalse(build.contains("buildConfigField(\"String\", \"GEMINI_API_KEY\""))
    }

    @Test
    fun `release signing requires private configuration without tracked defaults`() {
        val build = source("build.gradle.kts")
        val releaseBlock = build.substringAfter("release {").substringBefore("debug {")

        assertTrue(build.contains("File(rootDir, \"keystore.properties\")"))
        assertTrue(build.contains("System.getenv(\"KEYSTORE_PATH\")"))
        assertTrue(build.contains("System.getenv(\"STORE_PASSWORD\")"))
        assertTrue(build.contains("System.getenv(\"KEY_ALIAS\")"))
        assertTrue(build.contains("System.getenv(\"KEY_PASSWORD\")"))
        assertFalse(build.contains("?: \"upload\""))
        assertTrue(releaseBlock.contains("signingConfigs.getByName(\"release\")"))
        assertFalse(releaseBlock.contains("debugConfig"))
    }

    @Test
    fun `release endpoint never inherits the emulator loopback or demo mode`() {
        val build = executable(source("build.gradle.kts"))
        val releaseBlock = build.substringAfter("release {").substringBefore("debug {")

        // The release block previously set no API_BASE_URL at all, so it
        // inherited defaultConfig's http://10.0.2.2:3000/ and produced a
        // signed artifact pointing at the builder's own machine over
        // cleartext, which the app's network security config blocks.
        assertTrue(releaseBlock.contains("buildConfigField(\"String\", \"API_BASE_URL\""))
        assertTrue(releaseBlock.contains("mawaredReleaseApiBaseUrl"))
        assertFalse(releaseBlock.contains("10.0.2.2"))

        // Demo mode must be pinned, not inherited: -PmawaredDemoMode=true
        // would otherwise ship an all-mock ERP as a production build.
        assertTrue(releaseBlock.contains("buildConfigField(\"Boolean\", \"DEMO_MODE\", \"false\")"))

        // Staging endpoints must never leak into the release build type.
        assertFalse(releaseBlock.contains("onrender.com"))
        assertFalse(releaseBlock.contains("\"staging\""))
    }

    @Test
    fun `producing a release artifact fails closed without an https endpoint`() {
        val build = executable(source("build.gradle.kts"))
        assertTrue(build.contains("assembleRelease"))
        assertTrue(build.contains("bundleRelease"))
        assertTrue(build.contains("Release build requires -PmawaredReleaseApiBaseUrl"))
        assertTrue(build.contains("startsWith(\"https://\")"))
    }

    @Test
    fun `release base url is normalized to a Retrofit-compatible trailing slash`() {
        val build = executable(source("build.gradle.kts"))
        val releaseBlock = build.substringAfter("release {").substringBefore("debug {")
        // Retrofit's baseUrl() throws IllegalArgumentException unless the URL
        // ends in "/", so a bare origin like https://api.example.com would
        // build an artifact that crashes on first network use.
        assertTrue(releaseBlock.contains("endsWith(\"/\")"))
    }

    @Test
    fun `no signing credential is hardcoded anywhere in the build script`() {
        val build = executable(source("build.gradle.kts"))
        // The dead debugConfig block carried the public Android debug-keystore
        // values. They were never real secrets, but committed credential-shaped
        // configuration should not exist at all.
        assertFalse(build.contains("storePassword = \""))
        assertFalse(build.contains("keyPassword = \""))
        assertFalse(build.contains("keyAlias = \""))
        assertFalse(build.contains("debug.keystore"))
    }
}
