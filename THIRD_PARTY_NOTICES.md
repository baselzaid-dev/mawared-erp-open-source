# Third-party notices

The project MIT license covers project-authored material. Third-party dependencies retain their own terms.

| Material | Provenance and handling |
| --- | --- |
| Gradle wrapper | Gradle 9.4.1 upstream JAR matched to the [official SHA-256](https://gradle.org/release-checksums/). The embedded license is included in [docs/licenses](docs/licenses/Gradle-Wrapper-Apache-2.0.txt). |
| Android launcher icon | New vector in the repository. Previous artwork and screenshot were withheld pending provenance verification. |
| JavaScript dependencies | The npm lockfiles record exact versions. The license for [png-js](docs/licenses/png-js-MIT.txt) was verified from the installed package. The final lockfiles contain 377 backend and 306 web package entries, including optional platform variants. License metadata includes permissive licenses, MPL-2.0, CC-BY-4.0, and dual licensing. Use JSZip under its MIT option and preserve applicable notices for distributed bundles. |
| Android dependencies | The Gradle catalog records declared versions. CI resolved 125 components for vulnerability scanning. Complete the license and attribution inventory before distributing Android binaries. |

Dependency metadata is a starting point. The maintainer must confirm distribution rights for included contributions and attribution for any distributed bundles before publication.
