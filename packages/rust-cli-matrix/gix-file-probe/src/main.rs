use std::path::PathBuf;

fn main() {
    let git_dir = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .expect("usage: gix-file-probe GIT_DIR"),
    );

    let store = gix_ref::file::Store::at(
        git_dir.clone(),
        gix_ref::store::init::Options::default(),
    );
    let packed = store
        .open_packed_buffer()
        .expect("open packed-refs")
        .expect("packed-refs fixture exists");
    assert!(
        packed.iter().expect("iterate packed-refs").count() > 0,
        "packed-refs fixture is empty"
    );

    let graph = gix_commitgraph::at(git_dir.join("objects/info"))
        .expect("open commit-graph fixture");
    assert!(graph.num_commits() > 0, "commit-graph fixture is empty");
    println!("packed-refs and commit-graph file reads passed");
}
