# pytest runs from the repo root (`python -m pytest tools -q`); the oracles import each other by bare name.
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
