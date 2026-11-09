import java.io.FileInputStream
import java.util.Properties
import java.net.URI
import org.gradle.api.artifacts.component.ModuleComponentIdentifier
import org.gradle.api.artifacts.result.ResolvedComponentResult
import org.gradle.api.artifacts.result.ResolvedDependencyResult

plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.kotlin.compose)
  alias(libs.plugins.google.devtools.ksp)
  alias(libs.plugins.roborazzi)
}

val recoveryHost = (findProperty("mawaredRecoveryHost") as String?)
  ?.trim()?.lowercase() ?: "recovery.example.invalid"
require(recoveryHost.matches(Regex("[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+"))) {
  "mawaredRecoveryHost must be a DNS hostname without a scheme, path, or port"
}

fun assertPublicApiUrl(value: String, allowEmulatorHttp: Boolean = false) {
  val url = runCatching { URI(value) }.getOrNull()
  require(
    url != null && url.host != null && url.userInfo == null
      && url.rawQuery == null && url.rawFragment == null
      && (url.scheme == "https" || (
        allowEmulatorHttp && url.scheme == "http" && url.host == "10.0.2.2"
      ))
  ) { "Android API URLs must be public HTTPS URLs or the permitted debug emulator URL" }
}

android {
  namespace = "com.example"
  compileSdk = 36

  defaultConfig {
    applicationId = "io.github.baselzaiddev.mawared"
    minSdk = 24
    targetSdk = 36
    versionCode = 1
    versionName = "1.0"

    manifestPlaceholders["ownerRecoveryHost"] = recoveryHost
    buildConfigField("String", "OWNER_RECOVERY_HOST", "\"$recoveryHost\"")

    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

    // Demo/Mock is explicit only: -PmawaredDemoMode=true
    // Debug builds target the local emulator API by default.
    val demoMode =
      (project.findProperty("mawaredDemoMode") as String?)?.equals("true", ignoreCase = true) == true
    buildConfigField("Boolean", "DEMO_MODE", if (demoMode) "true" else "false")
    val apiBaseUrl = (project.findProperty("mawaredApiBaseUrl") as String?) ?: "http://10.0.2.2:3000/"
    assertPublicApiUrl(apiBaseUrl, allowEmulatorHttp = true)
    buildConfigField("String", "API_BASE_URL", "\"$apiBaseUrl\"")
    buildConfigField(
      "String",
      "MAWARED_NETWORK_TARGET",
      if (demoMode) "\"demo\"" else "\"local\""
    )
  }

  signingConfigs {
    create("release") {
      // Signing secrets live OUTSIDE Git: keystore.properties (repo root,
      // gitignored) first, environment variables as fallback. No hardcoded
      // passwords, no keystore inside the repo.
      val props = Properties()
      val propsFile = File(rootDir, "keystore.properties")
      if (propsFile.exists()) {
        FileInputStream(propsFile).use { stream -> props.load(stream) }
      }
      val storePath = props.getProperty("storeFile") ?: System.getenv("KEYSTORE_PATH")
      if (storePath != null) storeFile = file(storePath)
      storePassword = props.getProperty("storePassword") ?: System.getenv("STORE_PASSWORD")
      keyAlias = props.getProperty("keyAlias") ?: System.getenv("KEY_ALIAS")
      keyPassword = props.getProperty("keyPassword") ?: System.getenv("KEY_PASSWORD")
    }
    // A "debugConfig" signing block used to sit here with the well-known
    // public Android debug-keystore values. It was never assigned to any
    // build type and pointed at a debug.keystore that does not exist and is
    // gitignored, so it was dead configuration that merely looked like
    // committed credentials. Removed rather than left to be re-discovered.
  }

  buildTypes {
    release {
      isCrunchPngs = false
      isMinifyEnabled = false
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
      signingConfig = signingConfigs.getByName("release")

      // Release must NEVER inherit defaultConfig's emulator loopback
      // (http://10.0.2.2:3000/). It previously did, so `assembleRelease`
      // produced a signed APK pointing at the developer's own machine over
      // cleartext, which the app's own network security config then blocks.
      // The value comes only from -PmawaredReleaseApiBaseUrl, and the guard
      // below refuses to build a release artifact without it.
      // Normalized to end in "/": Retrofit's baseUrl() rejects anything else
      // with IllegalArgumentException at construction, so an operator passing
      // a bare origin like https://api.example.com would produce an artifact
      // that crashes on first network use. The debug default already carries the trailing slash.
      // Written without a nested lambda on purpose: StagingDebugNetworkConfigTest
      // extracts this block with a brace-naive regex, so any nested brace pair
      // in here — even inside a comment — silently breaks that extraction.
      val rawReleaseApiBaseUrl =
        (project.findProperty("mawaredReleaseApiBaseUrl") as String?)?.trim().orEmpty()
      val releaseApiBaseUrl =
        if (rawReleaseApiBaseUrl.isEmpty() || rawReleaseApiBaseUrl.endsWith("/")) rawReleaseApiBaseUrl
        else rawReleaseApiBaseUrl + "/"
      if (releaseApiBaseUrl.isNotEmpty()) assertPublicApiUrl(releaseApiBaseUrl)
      buildConfigField("String", "API_BASE_URL", "\"$releaseApiBaseUrl\"")
      // Pinned, not inherited: -PmawaredDemoMode=true must never be able to
      // ship an all-mock ERP as a production build.
      buildConfigField("Boolean", "DEMO_MODE", "false")
      buildConfigField("String", "MAWARED_NETWORK_TARGET", "\"production\"")
    }
    debug {}
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_11
    targetCompatibility = JavaVersion.VERSION_11
  }
  buildFeatures {
    compose = true
    buildConfig = true
  }
  testOptions { unitTests { isIncludeAndroidResources = true } }
}

// Fail closed before a release artifact can be produced without an explicit
// production endpoint. Scoped to the artifact-producing tasks only, so debug
// builds, lint, and unit tests are unaffected.
//
// This does not authorize building a release artifact — that remains a
// separate, explicitly approved action. It only ensures that if one is ever
// built, it cannot silently point at a developer loopback address.
run {
  val releaseArtifactRequested = gradle.startParameter.taskNames.any { requested ->
    val task = requested.substringAfterLast(':')
    task.equals("assembleRelease", ignoreCase = true) ||
      task.equals("bundleRelease", ignoreCase = true)
  }
  val configuredReleaseUrl =
    (project.findProperty("mawaredReleaseApiBaseUrl") as String?)?.trim().orEmpty()
  if (releaseArtifactRequested) {
    if (configuredReleaseUrl.isEmpty()) {
      throw GradleException(
        "Release build requires -PmawaredReleaseApiBaseUrl=https://<production-host>/ " +
          "so the artifact cannot inherit the emulator loopback default."
      )
    }
    if (!configuredReleaseUrl.startsWith("https://")) {
      throw GradleException(
        "mawaredReleaseApiBaseUrl must be an https:// URL; cleartext is blocked " +
          "by the app's network security config."
      )
    }
  }
}

// Emits a CycloneDX SBOM of the dependency graph that actually ships, for the
// dependency vulnerability gate to scan.
//
// The input is `releaseRuntimeClasspath`, resolved by Gradle — so it is the real
// graph including every transitive dependency, not the hand-written list in
// libs.versions.toml. That distinction is the whole point: the risk here is an
// old transitive nobody declared (okhttp pulling an outdated okio, say), which a
// declaration-only review can never see.
//
// Written as a plain task rather than by applying a third-party SBOM plugin: it
// adds no build dependency, and it is not coupled to any plugin's compatibility
// with this AGP/Gradle pair. The output is standard CycloneDX, so the scanner
// remains interchangeable.
//
// The task name deliberately avoids assembleRelease/bundleRelease so it cannot
// trip the release fail-closed guard above, and it builds no artifact.
// Everything below is deferred into afterEvaluate. AGP registers the variant
// configurations during its own evaluation, so `releaseRuntimeClasspath` does
// not exist yet at the top level — and because a top-level val is evaluated on
// every Gradle invocation, looking it up eagerly breaks unrelated tasks such as
// testDebugUnitTest and lintDebug, not merely this one.
//
// `org.gradle.configuration-cache=true` is on for this project, so the task body
// must not reach back into Project or the configuration container at execution
// time. It captures only serializable values and Providers: `rootComponent` is
// the configuration-cache-safe entry point into a resolved graph.
afterEvaluate {
  val output = layout.buildDirectory.file("reports/sbom/bom.json")
  val versionName = android.defaultConfig.versionName ?: "0"
  val rootComponent =
    configurations.named("releaseRuntimeClasspath").flatMap { configuration ->
      configuration.incoming.resolutionResult.rootComponent
    }

  tasks.register("mawaredDependencySbom") {
    group = "verification"
    description = "Writes a CycloneDX SBOM of the resolved release runtime dependency graph."
    outputs.file(output)
    // A security gate must re-read the graph every time rather than replaying a
    // cached result from an earlier dependency set.
    outputs.upToDateWhen { false }

    doLast {
    // Walked from the root rather than read from a flat list so the whole
    // transitive closure is captured; `seen` also terminates dependency cycles.
    val collected = linkedMapOf<String, Triple<String, String, String>>()
    val visited = mutableSetOf<String>()

    fun walk(component: ResolvedComponentResult) {
      if (!visited.add(component.id.displayName)) return
      for (dependency in component.dependencies.filterIsInstance<ResolvedDependencyResult>()) {
        val id = dependency.selected.id
        if (id is ModuleComponentIdentifier) {
          collected["${id.group}:${id.module}:${id.version}"] =
            Triple(id.group, id.module, id.version)
        }
        walk(dependency.selected)
      }
    }
    walk(rootComponent.get())

    val components = collected.values.sortedWith(
      compareBy({ it.first }, { it.second }, { it.third }),
    )
    if (components.isEmpty()) {
      // An empty SBOM must never be scanned and reported as "no vulnerabilities".
      throw GradleException(
        "Resolved releaseRuntimeClasspath produced no external components. " +
          "Refusing to write an empty SBOM, which would scan clean and mean nothing."
      )
    }

    fun escape(value: String): String =
      value.replace("\\", "\\\\").replace("\"", "\\\"")

    val entries = components.joinToString(",\n") { (group, name, version) ->
      val purl = "pkg:maven/${escape(group)}/${escape(name)}@${escape(version)}"
      """    {
      "type": "library",
      "group": "${escape(group)}",
      "name": "${escape(name)}",
      "version": "${escape(version)}",
      "purl": "$purl"
    }"""
    }

    val file = output.get().asFile
    file.parentFile.mkdirs()
    file.writeText(
      """{
  "bomFormat": "CycloneDX",
  "specVersion": "1.5",
  "version": 1,
  "metadata": {
    "component": {
      "type": "application",
      "name": "mawared-android",
      "version": "${escape(versionName)}"
    }
  },
  "components": [
$entries
  ]
}
"""
    )
    logger.lifecycle("Wrote CycloneDX SBOM with ${components.size} components to ${file.absolutePath}")
    }
  }
}

// Some unused dependencies are commented out below instead of being removed.
// This makes it easy to add them back in the future if needed.
dependencies {
  implementation(platform(libs.androidx.compose.bom))
  implementation(platform(libs.firebase.bom))
  // implementation(libs.accompanist.permissions)
  implementation(libs.androidx.activity.compose)
  // implementation(libs.androidx.camera.camera2)
  // implementation(libs.androidx.camera.core)
  // implementation(libs.androidx.camera.lifecycle)
  // implementation(libs.androidx.camera.view)
  implementation(libs.androidx.compose.material.icons.core)
  implementation(libs.androidx.compose.material.icons.extended)
  implementation(libs.androidx.compose.material3)
  implementation(libs.androidx.compose.ui)
  implementation(libs.androidx.compose.ui.graphics)
  implementation(libs.androidx.compose.ui.tooling.preview)
  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.datastore.preferences)
  implementation(libs.androidx.lifecycle.runtime.compose)
  implementation(libs.androidx.lifecycle.runtime.ktx)
  implementation(libs.androidx.lifecycle.viewmodel.compose)
  // implementation(libs.androidx.navigation.compose)
  implementation(libs.androidx.room.ktx)
  implementation(libs.androidx.room.runtime)
  implementation(libs.androidx.security.crypto)
  // implementation(libs.coil.compose)
  implementation(libs.converter.moshi)
  // implementation(libs.firebase.ai)
  implementation(libs.kotlinx.coroutines.android)
  implementation(libs.kotlinx.coroutines.core)
  implementation(libs.logging.interceptor)
  implementation(libs.moshi.kotlin)
  implementation(libs.okhttp)
  // implementation(libs.play.services.location)
  implementation(libs.retrofit)
  testImplementation(libs.androidx.compose.ui.test.junit4)
  testImplementation(libs.androidx.core)
  testImplementation(libs.androidx.junit)
  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)
  testImplementation(libs.robolectric)
  testImplementation(libs.roborazzi)
  testImplementation(libs.roborazzi.compose)
  testImplementation(libs.roborazzi.junit.rule)
  androidTestImplementation(platform(libs.androidx.compose.bom))
  androidTestImplementation(libs.androidx.compose.ui.test.junit4)
  androidTestImplementation(libs.androidx.espresso.core)
  androidTestImplementation(libs.androidx.junit)
  androidTestImplementation(libs.androidx.runner)
  debugImplementation(libs.androidx.compose.ui.test.manifest)
  debugImplementation(libs.androidx.compose.ui.tooling)
  "ksp"(libs.androidx.room.compiler)
  "ksp"(libs.moshi.kotlin.codegen)
}
