export default function PostPage({ params }: { params: { id: string } }) {
  return <article>Post {params.id}</article>;
}
