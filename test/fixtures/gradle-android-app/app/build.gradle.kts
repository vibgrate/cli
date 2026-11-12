plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.devtools.ksp")
    id("org.jetbrains.kotlin.kapt")
}

android {
    namespace = "com.example.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.example.app"
        minSdk = 24
        targetSdk = 34
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    flavorDimensions += "tier"
    productFlavors {
        create("free")
        create("paid")
    }
}

dependencies {
    // The same coordinate on a test configuration and on implementation.
    // Production wins in either order, and the production version is kept.
    androidTestImplementation("com.example:shared-replaced:9.9.9")
    implementation("com.example:shared-replaced:1.2.3")
    implementation("com.example:shared-kept:4.5.6")
    androidTestImplementation("com.example:shared-kept:9.9.9")

    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
    androidTestApi("androidx.test:runner:1.5.2")
    androidTestCompileOnly("androidx.test:rules:1.5.0")
    androidTestRuntimeOnly("androidx.test.espresso:espresso-core:3.5.1")

    debugImplementation("com.example:debug-impl:1.0.0")
    releaseImplementation("com.example:release-impl:1.0.0")
    freeDebugImplementation("com.example:free-debug-impl:1.0.0")
    debugApi("com.example:debug-api:1.0.0")
    paidReleaseApi("com.example:paid-release-api:1.0.0")
    debugCompileOnly("com.example:debug-compile-only:1.0.0")
    releaseRuntimeOnly("com.example:release-runtime-only:1.0.0")

    testFixturesImplementation("com.example:fixtures-impl:1.0.0")
    testFixturesApi("com.example:fixtures-api:1.0.0")

    ksp("com.google.devtools.ksp:symbol-processing-api:1.0.17")
    kaptTest("com.example:kapt-test:1.0.0")
    kaptAndroidTest("com.example:kapt-android-test:1.0.0")
    kspTest("com.example:ksp-test:1.0.0")
    developmentOnly("com.example:development-only:1.0.0")
    compileOnlyApi("com.example:compile-only-api:1.0.0")

    // Names embedded in a longer identifier are not configurations.
    xkapt("com.example:hidden-kapt:1.0.0")
    myapi("com.example:hidden-api:1.0.0")
    customkaptTest("com.example:hidden-kapt-test:1.0.0")
}
