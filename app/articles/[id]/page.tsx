import ArticleDetail from "@/components/ArticleDetail";

export const dynamic = "force-dynamic";

export default function Page({ params }: { params: { id: string } }) {
  return <ArticleDetail id={Number(params.id)} />;
}
