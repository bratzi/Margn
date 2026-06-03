import { sb, toPgVector, fromPgVector } from "./lib";

// Kosinus-Ähnlichkeit, ab der zwei Artikel als "dieselbe Geschichte" gelten.
// 0.80–0.85 ist ein guter Startbereich; je höher, desto strenger.
// e5-large staucht Cosine-Werte: Rauschen ~0.80–0.82, echte Stories ~0.86–0.90.
// 0.86 gegen Ketten-Cluster (vorher 0.58 für Cohere – Modellwechsel!).
const THRESHOLD = 0.86;
const NEIGHBORS = 10;
const BATCH = 200;

async function latestEmbedding(articleId: number): Promise<number[] | null> {
  const { data } = await sb
    .from("article_versions")
    .select("embedding")
    .eq("article_id", articleId)
    .not("embedding", "is", null)
    .order("scanned_at", { ascending: false })
    .limit(1);
  const raw = data?.[0]?.embedding;
  return raw ? fromPgVector(raw) : null;
}

async function clusterOf(articleId: number): Promise<number | null> {
  const { data } = await sb
    .from("article_clusters")
    .select("cluster_id")
    .eq("article_id", articleId)
    .limit(1);
  return data?.[0]?.cluster_id ?? null;
}

async function addToCluster(clusterId: number, articleId: number, similarity: number) {
  await sb
    .from("article_clusters")
    .upsert(
      { cluster_id: clusterId, article_id: articleId, similarity },
      { onConflict: "cluster_id,article_id" }
    );
}

async function newCluster(): Promise<number> {
  const { data, error } = await sb.from("story_clusters").insert({}).select("id").single();
  if (error) throw error;
  return data.id;
}

async function run() {
  const { data: candidates } = await sb.rpc("unclustered_articles", { lim: BATCH });

  for (const c of candidates ?? []) {
    const articleId = c.article_id as number;
    if (await clusterOf(articleId)) continue;

    const emb = await latestEmbedding(articleId);
    if (!emb) continue;

    // Sprachübergreifende Nachbarn finden
    const { data: neighbors } = await sb.rpc("similar_articles", {
      query_embedding: toPgVector(emb),
      match_count: NEIGHBORS,
    });

    const close = (neighbors ?? []).filter(
      (n: any) => n.article_id !== articleId && n.similarity >= THRESHOLD
    );

    // Hat ein naher Nachbar bereits ein Cluster? -> bestem beitreten, sonst neues anlegen.
    let target: number | null = null;
    let bestSim = 0;
    for (const n of close) {
      const existing = await clusterOf(n.article_id);
      if (existing && n.similarity > bestSim) {
        target = existing;
        bestSim = n.similarity;
      }
    }
    if (target === null) target = await newCluster();

    await addToCluster(target, articleId, 1);
    for (const n of close) {
      if (!(await clusterOf(n.article_id))) {
        await addToCluster(target, n.article_id, n.similarity);
      }
    }
    console.log(`Artikel ${articleId} -> Cluster ${target} (${close.length} Nachbarn)`);
  }

  // TODO (Stufe 2.3): pro neuem Cluster einen LLM-Aufruf, der `story_clusters.label`
  // mit einem kurzen Themen-Titel füllt und Framing/Buzzwords je Blatt extrahiert.
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
