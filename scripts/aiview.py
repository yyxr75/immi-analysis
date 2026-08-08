"""Single source for the AI panel's JavaScript.

scripts/ai_view.js is the only copy. report_template.html carries a marker
where it belongs, and every build injects it through here. Before this, the
template held a verbatim duplicate that had to be hand-edited in parallel --
which is exactly how the "test connection" and stale-payload bugs shipped.

Injection also fills __ANZSCO_LIST__ with the occupations the site actually
has data for. That list has to come from the built data, not from a literal in
the source: a model asked to name ANZSCO occupations from memory invents
plausible ones that are not on the list ("ICT Research Scientist", "Machine
Learning Engineer"), and every invented name is silently dropped downstream
because nothing in the index matches it.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "ai_view.js")
MARKER = "/*--AIVIEW--*/"
INDEX = os.path.join(HERE, "..", "site", "data", "occupations.json")


def load_index(path=INDEX):
    """The occupation index, as build_site.py writes it: code, name, pool."""
    with open(path) as f:
        return json.load(f)


def list_text(index):
    """One occupation per line, biggest pools first.

    The name in the index already carries the code ("233411 Electronics
    Engineer"), so a line is the code, a tab and the name -- compact enough
    that 492 of them stay a small share of the prompt, and unambiguous enough
    that the model can copy a code rather than recall one.
    """
    rows = sorted(index, key=lambda o: -o.get("pool", 0))
    return "\n".join(
        "%s\t%s" % (o["code"], o["name"].split(" ", 1)[-1]) for o in rows)


def ai_view_js(index=None):
    """ai_view.js with the ANZSCO list substituted in."""
    src = open(SRC).read()
    if index is None:
        index = load_index()
    # A JS string literal: the list is data, and a stray quote or newline in an
    # occupation name would otherwise end the literal early.
    return src.replace('"__ANZSCO_LIST__"', json.dumps(list_text(index),
                                                       ensure_ascii=False))


def inject(template, index=None):
    """Put the AI panel into a copy of report_template.html."""
    if MARKER not in template:
        raise ValueError("report_template.html has no %s marker" % MARKER)
    return template.replace(MARKER, ai_view_js(index))
