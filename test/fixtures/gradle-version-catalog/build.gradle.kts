dependencies {
    implementation(libs.jackson.databind)
    implementation(libs.guava.get())
    api(libs.commons.lang3)
    testImplementation(libs.bundles.test.stack)
    implementation(libs.junit.jupiter)
    compileOnly(libs.missing.pin)
    runtimeOnly(libs.slf4j.api)
    kapt(libs.lombok)
    api(platform(libs.jackson.bom))
    implementation("com.example:direct:1.2.3")
}
