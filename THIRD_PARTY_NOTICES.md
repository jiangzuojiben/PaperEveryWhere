# Components and provenance

PaperDesk contains independently written application code and original icons. It does not bundle ReadPaper application JavaScript or visual assets. REA is used as a research tool; its evidence and limitations are documented separately.

The application uses upstream components under their respective licenses, including:

- [Flutter](https://github.com/flutter/flutter), [pdfrx](https://github.com/espresso3389/pdfrx), and PDFium through pdfrx's native engine.
- SQLite, sqflite, and sqlite3 native assets.
- FastAPI, Starlette, SQLAlchemy, Celery, Redis client, boto3, HTTPX, cryptography, pypdf, pypdfium2, ReportLab, bibtexparser, and rispy.
- Additional Flutter and Python dependencies listed in `client/pubspec.lock` and `backend/requirements.lock`.

Upstream license files and transitive notices supplied with these packages remain applicable. The Windows portable package can include app-local C/C++ runtime DLLs from the existing Microsoft Visual Studio redistributable directory. These are runtime dependencies, not application source.

The local test PDF is generated for PaperDesk validation and contains no personal documents. Crossref and OpenAlex supply external metadata when configured and requested; their data is not bundled as a copied corpus.
